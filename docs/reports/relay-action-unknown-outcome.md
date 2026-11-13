# Relay action: production outcome diagnosis

All dates and times below are UTC on 2026-11-13. This report records acceptance 1 and the build contract for acceptance 2–5. Production inspection was read-only. The final interpretation includes the seat-relayed paired-service diagnosis, correlated with retained local evidence below.

**The cause of this incident is on the paired service: its action preparation failed before mutation, and it classified that proven no-effect failure as `outcome_unknown`.** The service seat identifies an identity mismatch in the immediate-apply preparation path, with zero rule writes and no confirmation step. All four service-reported execution intervals agree with this installation's independently retained bounds and raw result statuses. Delegatus received the service's unknown result without adding a local timeout or reclassification. The internal preparation error and zero-write finding come from the service diagnosis; this audit did not open its primary records. The build contract below adds automatic verification after uncertain outcomes.

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

The actual diff of PR #3939 was read. At 08:56 it was closed and unmerged; its answer composition/rendering files remain outside this report's implementation scope. The paused image-tool lane was read through its stage record and its branch diff; it contains no implementation delta against this base. The diagnostic stage edited no files belonging to either effort. The diagnostic stage changed only this report and ran no code checks. Its publication-hook requirement was deferred to the committing build stage; current build verification is recorded below.

The repository's unmodified privacy gate passed with exit 0 using committed known-value fingerprints and `bun scripts/privacy-publication-gate.ts --require-known-values --paths docs/reports/relay-action-unknown-outcome.md`, with HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR isolated under stage scratch and the control URL set to a closed loopback port. The final run's UTC start, output and actual exit are retained as `privacy-check-started.txt`, `privacy-check.txt` and `privacy-check.exit`. Manual review checked every report line for private names, quoted group text, opaque identifiers, credentials and absolute home paths. `git diff --check` passed. That diagnostic pass changed no implementation and claimed no performance gain.

## Incident cause and narrowed build handoff

**Incident cause: paired-service action preparation failed on an identity mismatch before any mutation; its result mapping reported uncertainty for a proven no-effect refusal.** Its four reported HTTP 200 unknown responses and roughly two-second execution durations match the locally preserved result statuses and time bounds. The internal exception, zero writes and absence of confirmation are attributed to the correlated service diagnosis. No Delegatus timeout or additional uncertainty classification caused these four results. The Viewer stalls account for delays, including D's later service arrival, without moving the action failure to this side. The service owner owns the preparation and refusal-classification repairs; their deployment remains unverified here.

The initial diagnostic handoff proposed fresh `list_triggers` reads. Subsequent contract inspection proved that route is refused after uncertainty and cannot compare complete rule configuration. The agreed build contract below supersedes that proposal and uses the action's own idempotent status through same-call replay. The service's live-lease rules still apply; new endpoints, protocol fields and cross-turn identities remain outside this lane.

## Build contract: read the saved outcome through the same call

The relay now establishes a declared action's outcome before composing its group reply. The trigger update is the first declaration in `src/lib/externalRelay/actionOutcome.ts`; additional tools use the same mechanism. This is a local TypeScript declaration of an idempotent verifying read through the action route; it has no configuration UI or CLI. It adds no endpoint, wire field or cross-turn identity. `list_triggers` remains unsuitable: the current service refuses it after a terminal action and its summaries cannot prove complete configuration equality. A preliminary cached listing is never used as proof.

After an uncertain result, lost response or transport failure, Delegatus repeats the original `POST /requests/{request}/tool-calls` body. The request identity, call identity, lease and canonical arguments are unchanged. Each verification rechecks the live lease and the before-send authority. The initial send, pending waits and up to three reads share one monotonic deadline of at most 30 seconds, capped by the original request lifetime with one second reserved for completion, covering waits, lease acknowledgements, DNS and response bodies. The deadline is checked again immediately before emission and after the response, including when event-loop stalls delay timers. Lease loss stops the request rather than acquiring new authority.

The expected existing response envelope identifies the same call and tool with `effect=action`. `status=ok` establishes done; `status=error` establishes not done. An unknown or pending response can consume another bounded read. A denial, invalid response, inaccessible status or spent deadline yields an explicit verification failure naming the saved outcome that could not be read. Transport failures cannot become proof of no effect. The service's current post-terminal refusal is supported as verification failure, so deploying this side does not depend on a simultaneous service release.

A group member receives a plain result: done, not done, or verification failed naming the action. For example, an English request gets `Done: trigger rule update.` or `Not done: trigger rule update.`; a Ukrainian request gets the corresponding Ukrainian reply. Verification failure explicitly names the saved action outcome that could not be read. The member path finishes directly from the established result; it does not need another model round to restate it. The same outcome overrides an agent's contradictory final answer or inability to produce one. The outcome is also retained in the existing tool-call record. Before the first POST, possible emission, verification count and expiry are stored in the existing request-claim ledger. A restored call enters verification and consumes that same budget before any POST; process restart, lease replacement and claim release preserve the bound. Even a crash immediately before emission conservatively requires verification, and a later authorization refusal cannot prove that an earlier effect did not happen. Older bounds created after uncertainty are also treated as recovery. These records contain dispatch evidence and bounds only; the service remains the sole owner of action outcomes. New request admission prunes expired bounds after the same 24-hour retention window as request claims, and each request admits at most 16 action keys. Audience-restricted service output, rule text and call arguments are excluded from this fixed group reply.

### Paired-service dependencies

The service owns these two guarantees, agreed as the build contract and still requiring its own release verification:

1. A replay of the same request/call pair with identical arguments returns its saved settled outcome. An accepted action's effect and terminal receipt must commit together, and replay must not execute that effect again. A currently refused or permanently uncertain replay produces an explicit verification-failed reply here. A live lease remains required by this implementation; replay after a turn or lease ends is outside this lane.
2. A definite not-done result is authoritative: the original worker is fenced and cannot subsequently write. A stored terminal no-effect receipt remains no effect when replayed. A refusal before acceptance can leave no accepted receipt; retrying that original identity can then apply once. No negative snapshot is used to infer finality.

The service must also fix the incident's preparation identity mismatch and classify proven pre-effect failures as definite errors. Its intended wire uses the existing statuses above. This stage does not change or deploy that service. The exact release carrying both guarantees remains an open dependency for its owner. An accepted terminal no-effect receipt remains no effect on replay.

### Unresolved acceptance: retry from a new member message

The same-request retry test does not prove the required user retry across messages. The full runner reproduction in `src/lib/externalRelay/runner.test.ts` delivers two member requests with separate claims and leases. The first receives not done and the second receives done with one effect, but both the request route and call identity change. The service key is the pair of request and call identity; preserving only one component would also fail acceptance.

The current request schema supplies no reference from a fresh member request to the earlier action. A settled request/lease pair has a terminal local claim; the old live lease cannot simply be replaced by a new message's lease. Equal arguments cannot establish that two member messages are one logical intent. The agreed constraint forbids adding a cross-turn identity or wire field in this lane. Consequently acceptance 3's member retry requirement is blocked pending an agreed service redelivery/authorization contract, or an explicit change to that constraint. The reproduction is retained as `test.failing` and is also run without that marker to capture the actual identity mismatch. It must become a normal passing regression once the contract is implemented. The before-acceptance test covers only replay of the original request, and no cross-message guarantee is claimed.

### Verification record

The acceptance tests use an ephemeral loopback service in a separate process with a durable receipt ledger. They cover response loss after acceptance, timeout before acceptance followed by same-key retry, a delayed worker, verification failure, each with a three-second client event-loop stall, and both current-service refusal modes. Worker progress is released through an acknowledged test barrier independently of the verifying read. Additional cases enforce deadline checks around waits and emission, reject late success and mismatched identity/effect, stop on lost authority, replay after a real service restart, and prevent late writes after a terminal no-effect receipt. No real service call or group message is part of verification.

The command, exit and assertion counts are recorded in `evidence/relay-action-outcome/checks.md`. No throughput or latency improvement is claimed. Production state and serving processes remain untouched.
