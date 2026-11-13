# Relay action: production outcome diagnosis

All dates and times below are UTC on 2026-11-13. This report addresses acceptance 1 and specifies the narrowed build handoff for acceptance 3 and 4. Production inspection was read-only. The final interpretation includes the seat-relayed paired-service diagnosis, correlated with retained local evidence below.

**The cause of this incident is on the paired service: its action preparation failed before mutation, and it classified that proven no-effect failure as `outcome_unknown`.** The service seat identifies an identity mismatch in the immediate-apply preparation path, with zero rule writes and no confirmation step. All four service-reported execution intervals agree with this installation's independently retained bounds and raw result statuses. Delegatus received the service's unknown result without adding a local timeout or reclassification. The internal preparation error and zero-write finding come from the service diagnosis; this audit did not open its primary records. The remaining work here is the required automatic verification after uncertain outcomes.

## Serving release and evidence

At 08:51:45, the running Viewer command, its process working directory, the runtime-host command and the launcher's child all resolved to release `ce7806df4acef79bbf76221943227e86c59863a9`. Historical loop-gap records during the incident name this same revision. Thirteen relevant serving source files were compared byte-for-byte with that revision's Git blobs; all matched. Source references below refer to this deployed revision, which also equals the stage's starting revision.

Production files were read with Python's file readers. No application store module, API handler, database connection, descriptor refresh, service tool or live history fetch was invoked. This matters because `readRelayStore()` can persist expired-pairing cleanup (`src/lib/externalRelay/store.ts:195`). No runtime write, restart, deployment, message, trigger update or action replay was performed by this audit.

Primary sources retained privately under `$LLV_EVIDENCE_DIR`:

- Answer files selected from `$HOME/.config/delegatus/state/external-relay/answers/`, plus snapshots of `requests.json`, `runs.json` and `conversations.json` from that directory. The four records were first captured at 08:50:13; their terminal request claims remain, and none remains in the run ledger after normal cleanup.
- Four native member-agent transcripts, located through each request's exact conversation anchor and recorded native session, copied at 08:51:45. Copies are `attempt-A-transcript.jsonl` through `attempt-D-transcript.jsonl`; the private mapping retains the original paths. No message contents or opaque identifiers are reproduced here.
- `viewer-journal-hour-full.jsonl`, captured starting at 08:52:54, covering 08:00:00–08:46:00. The primary incident window is 08:38:00–08:44:00. `--all` is necessary: without it, journal JSON replaces long diagnostic messages with null, concealing loop-gap evidence. The complete capture contains 8,547 records with string messages.
- `serving-source-manifest.json`, `paired-endpoint-private.json`, `attempt-map-private.json`, `acceptance-summary.json`, source copies and extracted tool projections. They preserve private correlation and checksums without publishing identities.

The final extraction ran at 08:58:59.502–08:58:59.547:

```sh
rtk proxy python3 -I "$LLV_EVIDENCE_DIR/read-relay-evidence.py" \
  --state "$HOME/.config/delegatus/state/external-relay" \
  --evidence "$LLV_EVIDENCE_DIR" \
  --since 2026-11-13T08:36:00Z --until 2026-11-13T08:46:00Z
```

The retained helper only reads production JSON; its writes are confined to the private evidence directory. The journal command was:

```sh
rtk proxy journalctl --user -u delegatus.service \
  --since '2026-11-13 08:00:00 UTC' \
  --until '2026-11-13 08:46:00 UTC' --all -o json --no-pager
```

Release checks used `readlink /proc/<viewer-process>/cwd`, the recorded processes' `cmdline` files, and `git show ce7806df4ace:<source-path>` comparisons. The private census retains process numbers. Prior-answer searches used `search_transcripts`, project-scoped then unscoped, for the action name and outcome/deadline variants, and `search_memory` for relay outcome and deadline terms. No earlier diagnosis of these four attempts was found. The existing action design explicitly requires a reply-only unknown final (`docs/design/relay-slice2b-actions.md:127`); that historical contract explains the current behaviour and is superseded by this task's acceptance 3.

## Four-attempt timeline for correlation

**Timing precision:** exact socket-send and HTTP-receive timestamps were never persisted. The intervals below bound both the outgoing action request and the returned result: the lower bound is the model's structured action emission; the upper bound is the next transcript message containing the service result. They are not measured network latency. The result arrived before its upper bound. No finer timestamp can be recovered from this installation's retained records.

`P` denotes the single paired API base, with path `/api/relay/v1`; its private origin is withheld from this public report. `paired-endpoint-private.json` retains the exact base for correlation. Every attempt belongs to that same pairing. The base is stored at pairing (`pairing.ts:105`); current refreshes change features and targets. No per-call base or backend identity is stored, so use of this stored base is a code/configuration inference, not a historical packet capture.

`R` denotes the observed result: `tool=request_trigger_rule_update`, `status=outcome_unknown`, empty `output`, `truncated=false`, `replayed=false`, `audience=admin`, no error code, `withheld=false`, `local=false`. Its projection has no `execution_unknown` or `delivered` marker. The response passed the schema and matching call/tool checks. The numeric HTTP status and complete raw envelope were not retained; the transport accepted the response. `B` denotes the deployed classification path described after the table.

| Attempt; originating request time | Request leaving Delegatus: retained bound | Route and destination | Timeout/deadline in force | Returned result and retained time | Classification |
| --- | --- | --- | --- | --- | --- |
| A; 08:38:36.005745 | After 08:38:52.875, before 08:38:57.181; exact send absent | `POST P/requests/{request}/tool-calls`; `request_trigger_rule_update`; backend instance absent | 30,000 ms socket inactivity timeout, `toolLoop.ts:117`, implemented by `client.ts:193`; absolute request deadline absent from retained record | R, received by 08:38:57.181; complete emission-to-projection bound 4.306 s | B; action in round 1, then final reply |
| B; 08:39:56.104401 | After 08:40:48.598, before 08:40:55.450; exact send absent | Same route, tool and inferred base P; backend instance absent | Same 30,000 ms; absolute request deadline absent from retained record | R, received by 08:40:55.450; bound 6.852 s | B; `list_triggers` in round 1, action in round 2, then final reply |
| C; 08:41:57.481221 | After 08:42:26.318, before 08:42:33.002; exact send absent | Same route, tool and inferred base P; backend instance absent | Same 30,000 ms; absolute request deadline absent from retained record | R, received by 08:42:33.002; bound 6.684 s | B; read in round 1, action in round 2, then final reply |
| D; 08:42:05.498315 | After 08:42:31.343, before 08:42:55.943; exact send absent | Same route, tool and inferred base P; backend instance absent | Same 30,000 ms; absolute request deadline absent from retained record | R, received by 08:42:55.943; bound 24.600 s | B; read in round 1, action in round 2, then final reply |

Table references abbreviated as `toolLoop.ts`, `client.ts` and `pairing.ts` are under `src/lib/externalRelay/`. Each action sent arguments with a rule name, `filter` containing `filter_type=whole_word`, a word array and `case_sensitive=false`, and `action` containing `action_type=send_message` and `send_message.text`. Word counts were respectively 4, 8, 4 and 10. The four canonical argument objects differ; they must not be treated as byte-identical retries. Their private originals are retained. No rule names, words or reply texts are copied here.

The absolute `deadline_at` is top-level input to `relayRequestDeadline()` (`deadline.ts:15`); the answer recorder persists only `rawRequest.input` (`runner.ts:245`). Completed member run custody is removed, so that value is unavailable. There is no fallback-deadline diagnostic for these requests. The fallback is 600,000 ms (`deadline.ts:5`), but calling it the observed service deadline would be unjustified. The separate 330,000 ms pending-operation guard (`toolLoop.ts:110`) did not expire in any of these intervals.

The local answer records finished at A 08:39:03.765, B 08:41:02.094, C 08:42:50.898 and D 08:43:03.124. Accepted-completion tombstones were written at 08:39:05.535, 08:41:03.208, 08:42:53.010 and 08:43:04.068 respectively. All have `outcome=answered`, `delivery=accepted`. These fields confirm acceptance of the relay's final answer by the service; they do not confirm successful trigger creation or independently prove Telegram display.

### Correlation with the service diagnosis

The service seat supplied the following arrivals and execution durations. The response-end column is calculated from those two supplied values; local projection times and status fields come independently from the retained transcripts and answer records. Every reported service interval lies completely inside its corresponding local action-emission-to-result-projection interval. The numerical comparison, performed at 09:10:37.630 using `rtk proxy python3 -I "$LLV_EVIDENCE_DIR/correlate-peer-timeline.py"`, is retained in `peer-timeline-correlation.json`.

| Attempt | Service-reported arrival | Service-reported duration | Calculated service response end | Local result present by | Response end to local projection |
| --- | --- | --- | --- | --- | --- |
| A | 08:38:54.080 | 1.89 s | 08:38:55.970 | 08:38:57.181 | 1.211 s |
| B | 08:40:51.950 | 2.42 s | 08:40:54.370 | 08:40:55.450 | 1.080 s |
| C | 08:42:27.330 | 2.17 s | 08:42:29.500 | 08:42:33.002 | 3.502 s |
| D | 08:42:52.730 | 2.05 s | 08:42:54.780 | 08:42:55.943 | 1.163 s |

For all four, the service reports HTTP 200 with `outcome_unknown`; local rows independently preserve that exact status with `local=false`. There is no contradiction in timing, sequence or result shape. This supports the reported roughly two-second service execution and subsequent local consumption. Exact two-second HTTP round trips cannot be independently measured here because socket timestamps were never retained; the last column includes delivery, local processing and transcript-start overhead. D reaches the service after the long Viewer stall, consistent with local scheduling delay before its arrival. No local timeout expired and no local unknown-result synthesis replaced any of the four results.

The correlated service explanation is a failure before mutation on the immediate-apply path, followed by incorrect uncertainty classification. This puts the incident's action failure and misleading service status on the paired-service side. Its owner is repairing the preparation path so the action succeeds and mapping a proven pre-effect refusal to a definite not-applied result using existing fields and enum meanings. This audit has not verified deployment of that repair. Local evidence independently proves receipt and preservation of the service status; it does not independently expose the service's preparation exception. No unsupported claim of backend colour, revision or connection reset follows from this correlation.

### Classification B on the deployed release

`toolLoop.ts:116` sends the action. `:119` parses the response; `:120` checks the returned call identity and tool. `:126` makes a service `outcome_unknown` terminal, `:130` sets `sawUnknown`, and `:150` returns that actual result. Projection preserves the raw status at `:250`; durable rows set `local` from the presence of a raw result at `:285`.

This distinguishes all four attempts from local synthesis: `unknown()` at `:90` returns a null result, which would produce `local=true`. Transport exhaustion at `:184`, conflict at `:164` and the pending guard use that local path. None describes the four saved action rows. Their projections also lack the `execution_unknown` flag used for exhausted service `denied/unavailable` handling (`:145`, `:269`).

After the raw unknown result, `callsLeft()` returns zero because `terminal` is set (`:84`). `runner.ts:910` therefore makes the next round final. `prompt.ts:64` directs the agent to finish on uncertainty; no verifier runs. Each native transcript shows the resulting final reply. The paired service renders the group-visible progress/status notice; this report does not reproduce it. Changing that notice alone would leave the missing verification and failed action unresolved.

## State observations and load

The B, C and D preliminary `list_triggers` results were projected at 08:40:43.373, 08:42:20.195 and 08:42:25.096. All three outputs are byte-identical and contain three existing rules. They do not contain the requested additions. Thus A's requested effect was absent at the later B read, and B's requested effect remained absent at the later C/D reads. These are state observations at those reads; they cannot exclude a later write.

No attempt performed its own post-action verification. In particular, the last preliminary read precedes C's and D's action emissions. This installation therefore does not independently prove the final absence of C's and D's effects. The service diagnosis supplies the zero-write finding for all four, consistent with the local observations. This attribution is explicit because its primary action/state records were not read by this audit.

The full journal contains 93 Viewer loop-gap records and ten runtime-host gap records in 08:38:00–08:44:00. The two Viewer gaps above three seconds were:

| Last Viewer heartbeat | Next Viewer heartbeat | Reported excess gap | Diagnostic UTC; journal arrival |
| --- | --- | --- | --- |
| 08:40:00.027539 | 08:40:23.383167 | 23,346 ms | 08:40:23.388; 08:40:24.483300 |
| 08:42:32.683002 | 08:42:51.017160 | 18,324 ms | 08:42:51.018; 08:42:52.708473 |

The runtime host's largest recorded gap in that window was 611 ms. The first long Viewer gap delays B's claim/admission; it precedes B's action. The second overlaps D's action/result interval and delays C's completion. These stalls are real. They do not explain the service-supplied status in A, B and C. All four complete action intervals are shorter than the local 30-second socket timeout, ruling out expiry of that timeout as their classification source. This is a timing bound, not a performance improvement claim or proof that load had no effect inside the paired service.

No matching relay launch failure, answer-record write failure, run-ledger cleanup failure, fallback deadline, `ECONNRESET`, `ECONNREFUSED` or socket-hang diagnostic was found in the complete 08:00–08:46 service journal. Tool-call transport errors are caught without a durable per-attempt log, so absence of such a diagnostic does not exclude a transient error followed by a valid response.

### Release-switch evidence limits

There are no retained remote response headers, resolved peer addresses, connection identifiers, service version fields, serving colours or backend instance labels for these calls. `client.ts:104` opens a fresh request with `agent=false`; `:188` resolves only status and parsed body. The tool-call recorder retains selected result fields, not transport provenance (`answers.ts:32`, `toolLoop.ts:283`). Consequently, neither a backend switch nor all four calls landing on one backend can be proved. The local runtime entry proxy handles inbound Viewer traffic, not these outbound HTTPS requests; its error branch (`src/runtime-host/deploymentProxy.ts:361`) provides no outbound request journal. No request to the paired service was made to fill this gap.

## Durable-write path and audit limits

For these member requests, the relevant durable writes occur in this order: request claim (`runner.ts:214`); conversation/anchor resolution before capacity admission (`:721`); run reservation (`:794`); chain reservation (`:801`); native CLI session/transcript and answer-record admission (`:1107`), followed by child identity persistence (`:1108`); final answer with tool-call rows (`:359`); terminal request claim (`:475`) and accepted delivery annotation (`:485`); then conversation release and run cleanup (`:1338`, `:1357`). The final-answer timestamp precedes its completion acknowledgement. Tool projections are request-memory data until recorded at completion. The service owns the durable action-call ledger; this installation has no independent per-action dispatch ledger.

No relay statistics ledger is written before admission on this claim path; activity/progress notes are in memory. Answer-record write failures are explicitly logged (`answers.ts:118`, `:183`, `:201`). Store writes use atomic rename and propagate failures (`store.ts:171`); cleanup failures are logged (`runner.ts:1359`). None of the four terminal records indicates failed admission or lease loss. Normal custody removal explains their absence from the current run ledger; absence there is not evidence of non-dispatch.

Exact HTTP send/receive times, numeric action HTTP statuses, intermediate retries, absolute service deadlines and backend identities were not recorded and cannot be reconstructed by granting more read access to this installation. The matched service diagnosis now supplies HTTP statuses, execution intervals and the service-internal cause with the provenance stated above. Its primary records and release-routing evidence remain outside this audit; no new production call or access request is needed to complete the narrowed local handoff.

The actual diff of PR #3939 was read. At 08:56 it was closed and unmerged; its answer composition/rendering files remain outside this report's implementation scope. The paused image-tool lane was read through its stage record and its branch diff; it contains no implementation delta against this base. No files belonging to either effort were edited. This stage changes only this report, with no staging or commit. Code tests, typecheck and lint were not run for a prose-only audit. There is no final commit on which to run the requested publication hook; the unmodified pre-push hook belongs to the later committing build/publication stage.

The repository's unmodified privacy gate passed with exit 0 using committed known-value fingerprints and `bun scripts/privacy-publication-gate.ts --require-known-values --paths docs/reports/relay-action-unknown-outcome.md`, with HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR isolated under stage scratch and the control URL set to a closed loopback port. The final run's UTC start, output and actual exit are retained as `privacy-check-started.txt`, `privacy-check.txt` and `privacy-check.exit`. Manual review checked every report line for private names, quoted group text, opaque identifiers, credentials and absolute home paths. `git diff --check` passed. No implementation or performance gain is claimed.

## Incident cause and narrowed build handoff

**Incident cause: paired-service action preparation failed on an identity mismatch before any mutation; its result mapping reported uncertainty for a proven no-effect refusal.** Its four reported HTTP 200 unknown responses and roughly two-second execution durations match the locally preserved result statuses and time bounds. The internal exception, zero writes and absence of confirmation are attributed to the correlated service diagnosis. No Delegatus timeout or additional uncertainty classification caused these four results. The Viewer stalls account for delays, including D's later service arrival, without moving the action failure to this side. The service owner owns the preparation and refusal-classification repairs; their deployment remains unverified here.

**The build stage here narrows to acceptance 3 and 4, with the pinned checks for its touched files.** Implement automatic verification and fake-service coverage using the existing wire. A new status endpoint, cross-turn operation identity, service protocol extension, wider transport telemetry and a timeout increase are outside this repair. The service confirmed that disconnection does not cancel its worker, ordinary wait expiry returns `pending`, action deadline expiry can return `outcome_unknown`, recovery needs a live lease, and idempotency is scoped to `(request_id, call_id)` with immutable arguments. There is no action-status read after turn completion; `list_triggers` is the available read-back for trigger updates.

Make these concrete changes here:

- In `src/lib/externalRelay/toolLoop.ts:90`, `:126` and `:145`, enter a deterministic verification phase for an action whose outcome is unknown, including lost-response and timeout paths. Keep new actions and handoff fenced. Reserve capacity for the tool's declared matching read and perform it before final completion; for `request_trigger_rule_update`, use `list_triggers` on the same service under the same authority. Share the verifier with the owner adapter. `runner.ts:910` must not make the reply final while this verification is owed, and `prompt.ts:64` must reflect the verified result instead of directing an uncertainty final.
- Make every verification read fresh. `callBody()` currently derives its key from request plus canonical arguments (`toolLoop.ts:33`), and both the request cache and service ledger replay that identity. Reusing the earlier `list_triggers` key would return the pre-action result. Give each bounded verification read a distinct call identity within the existing wire, while preserving that read's own identity on transport retries. Cover this explicitly with a fake service that caches reads by the real request/call pair.
- Use at most three fresh verification reads under one absolute deadline capped by the request's remaining lifetime, reserving completion time. Count pagination within the bound. Wait asynchronously; a retry or multi-second event-loop stall must not reset the deadline. Compare the requested rule with returned state using the existing read contract, preserving audience restrictions. Before `runner.ts:1225`, produce a definite done or not-done answer from that verification. Only failed verification may produce a verification-failed answer, naming `list_triggers` or the specific read that could not establish the state. A generic unknown final is insufficient when a successful matching read establishes the result.
- Preserve the original action's `request_id`, `call_id` and exact canonical arguments on retry only while the service's live-lease rules permit recovery. Changed arguments under the same pair are refused. Once that pair can no longer be used, make a new call only after read-back has proved the requested action was not applied. Disconnect alone, a missing response, or an expired lease does not prove this: the service worker can continue after disconnection. A state read taken while application can still be pending must not justify an unsafe new action. Read-back is required before either retry path; no automatic action retry follows an inconclusive verification. The four historical payloads differ and do not qualify as identical retries.
- Add fake-service tests through the real relay runner for an accepted action whose response is lost (verify done), timeout before acceptance (verify not done, identical live-lease pair retry applies once), an expired/unusable lease (a new call is allowed only after verified no effect), slow action completing within the deadline, failed verification read, and each under a multi-second event-loop stall. The fake must honour request/call idempotency, immutable arguments, read replay and workers that survive caller disconnection. Assert bounded fresh reads, one shared deadline, no false not-done decision while a write remains pending, and no real paired-service calls. Run each touched test file by path in its own command through the prescribed gate with isolated HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR and a closed Viewer-control URL, one runner at a time. Complete typecheck, lint, privacy and the unmodified final-commit pre-push hook in the build stage.

## Build prerequisite: verifying reads are currently refused

Before implementing this handoff, obtain the paired service's agreement on the three requirements below. Its current source contradicts the handoff's assumption that a fresh matching read is available after an unknown result. This section supersedes that assumption; the incident diagnosis above remains unchanged. No production action or service request was made during this source inspection.

The build inspected the paired service's main revision through its source API, retaining the exact revision and three source files privately with the build evidence. References in the next paragraphs are paths in that service. They describe inspected source, without claiming that this revision is deployed.

In `apps/backend/application/usecase/clones/relay_tool_call.py:1010`, persisting an `outcome_unknown` result sets `tool_calls_terminal`. `_remaining()` at line 163 then returns zero. Admission at line 733 rejects every new call, including `list_triggers`, with `status=denied`, `code=too_many_calls` and `calls_remaining=0`. A fresh read identity avoids the old read's cached result but reaches this refusal. Reusing the old identity returns the old snapshot. Changing only Delegatus cannot produce the requested post-action state observation on that path.

The read also lacks a complete comparison representation. `apps/backend/ai_agent/agent/tools/group_settings/triggers.py:76` emits each rule's locator, name, fingerprint and localized `match` and `action` descriptions. `apps/backend/application/usecase/group_settings_management/security/trigger_descriptions.py:24` omits the whole-word filter's `anti_evasion` value. Its `_summarize_text()` at line 213 truncates reply text after 157 characters plus an ellipsis. Two different requested rules can therefore yield the same listing. An empty listing is localized prose rather than an empty array. The opaque fingerprint identifies a listed rule but cannot be calculated from the submitted action arguments using the exposed contract.

The paired service must provide these behaviours before a faithful fake can support the requested success cases:

1. Keep action dispatch fenced after uncertainty while admitting up to three fresh, authorized verification reads under the live request lease and the existing call/output bounds. For example, after the original action returns `status=outcome_unknown`, an existing-route tool call with `tool=list_triggers`, empty arguments and a distinct read identity must return the current state rather than `denied/too_many_calls`. Repeating that read's own identity must retain normal replay semantics. No new endpoint is required.
2. Return complete, machine-readable rule configuration inside the existing read `output`, including the filter, action parameters and effective defaults, with an unambiguous empty collection and explicit pagination. Agree the exact representation before implementing the local declaration that pairs the action with this read. A localized, shortened description cannot prove configuration equality.
3. Define when a negative observation proves no effect can still occur. A worker that survives disconnect may write after an empty read. Preserve recovery with the original request/call pair and immutable arguments under a live lease; after that lease becomes unusable, admit a new action only after a service-authoritative terminal no-effect result. An empty snapshot alone supplies no such guarantee. A concrete implementation may use the existing action response for a settled failure and the existing read output for reconciliation; an action-status endpoint remains outside this lane.

The acceptance-4 fake must preserve these current refusal and replay behaviours until an amended service contract is agreed. Inventing successful post-terminal reads or complete rule fields in the fake would conceal the dependency. Product implementation and the acceptance-4 campaign are pending that agreement. Group members' current outcome messages remain unchanged by this documentation amendment.

A scratch-only prerequisite probe exercised the real Delegatus tool loop and HTTP client against a loopback fake preserving the inspected terminal-budget and replay rules. The loop ended with `outcome_unknown`; a distinct `list_triggers` call, sent separately to bypass the local terminal fence, received `denied/too_many_calls`. The prescribed gate completed with exit 0: one file, one passing test, zero failures and five assertions. This is a contract-obstacle probe, not the acceptance-4 campaign or a production service test. A separate execution of the retained service's actual `_summarize_text()` function passed two assertions showing distinct reply texts produce identical listing descriptions. The probe source, terminal gate record, pinned service source and comparison evidence remain private.
