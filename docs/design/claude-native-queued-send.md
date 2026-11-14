# Claude input during a running turn

The operator's requirement, reported on **2026-11-13 at approximately 10:20 UTC**, is that a decision followed by two quickly submitted messages reaches Claude while its work continues, in submission order. The report describes the follow-ups waiting for the entire turn. Source: the originating operator report pinned to this task; public tracking issue **#2742**. This continues the **2026-09-11** request for native queued sending comparable to Codex. Private conversation wording and project names are omitted.

This is an implementation specification. Its completion does not establish that native queued delivery has shipped. The installed-CLI observation, its limits, and this stage's checks are recorded below.

## Scope and current behavior

The inspected source is `4931ed1da00ca71aa3dba8ca939c7cc662bcc27e`. Remote main and the checkout agreed when inspected on 2026-11-13. No source changes, merges, staging, commits, publication, deployment, or controls against existing agents belong to this design stage.

Issue #2742 remains open. It records CLI 2.1.284 merging two pending inputs into one replay UUID and emitting several echoes before one result. PR **#3934**, inspected at `e1f6e66d8b2b512f7acb3d5c1d736dedb68cf45f`, remains open. Its actual diff contains only `docs/verification/claude-queued-send-containment.md` and `src/lib/runtime/claudeStreamBrokerHost.nativeQueue.test.ts`. It verifies contained delivery, images, receipts, controls and restart. Its 2.1.322 protocol probe also observes caller UUIDs in `result.user_message_uuids`. That last observation requires renewed evidence on the installed binary.

There are currently two distinct admission paths:

| Site at the inspected revision | Current behavior and limit |
| --- | --- |
| `src/lib/runtime/claudeStreamBrokerHost.ts:704` | `supportsQueuedSend=false`; the broker also declares `acceptsInputDuringTurn=true` and `coalescesQueuedInput=true`. |
| `structuredDeliveryQueue.ts:1866` | A current seat composes its inbox with the existing `composeBatch`, binds the original operations with `bindDeliveryBatch`, and waits for idle. Coalescing currently requires `supportsQueuedSend=false`. |
| `structuredDeliveryQueue.ts:2393` | An ordinary operator send can join an active turn, with no caller turn fence or idle-only condition. Attention keeps this path waiting. Seat coalescing excludes it. |
| `structuredDeliveryQueue.ts:2425,2666` | An unsettled handover blocks further sends on the conversation; controls have their own path. Merely enabling the capability would retain this additional bottleneck. |
| `claudeStreamBrokerHost.ts:1152,1211` | At most one input waits behind the incumbent. Stdin receives no caller UUID. The ledger is written before stdin. |
| `claudeStreamBrokerHost.ts:1683` | A unique content match allocates a replay UUID and may remove a pending turn slot on an echo before the incumbent result. Such an echo alone cannot establish which result will consume that input. |
| `claudeStreamBrokerHost.ts:1862` | The result handler checks singular `user_message_uuid`, shifts a slot, and promotes another slot. It does not read the plural membership array. |

Consequently, the historical statement that every operator send waits for idle is incomplete for current main. The originating two-message seat case still requires work. Enabling a capability alone cannot satisfy it.

## Observation of the installed CLI

On **2026-11-13**, the installed binary reports **Claude Code 2.1.323**; its SHA-256 is `604d29a6869409106b6a1110bdadcc8b72e8654a5a865d23258f938a696e348e`. The test interpreter is Bun **1.4.0**. The first run's CLI frames were recorded from **11:31:36 to 11:32:04 UTC**, after gate admission. The scratch probe and raw/compact frames are retained as stage evidence under `identity-20261113/`. The published excerpts below contain synthetic messages and aliases for generated identifiers.

The observer spawned the installed binary from a fresh directory outside the repository. It constructed the child environment explicitly, with private HOME/config/temp/state/Claude config directories, disabled nonessential traffic and updates, blackholed non-loopback proxy traffic, and pointed the Messages API to a fixture server bound to `127.0.0.1` on port 0. Synthetic authentication remained inside the fixture. It copied no login, account settings or MCP configuration. The local API supplied every assistant response; this establishes protocol behavior, without testing a real model's interpretation of the instructions.

The direct CLI arguments, observed from `claude --help`, were:

```sh
"$CLAUDE" --print --verbose \
  --input-format stream-json --output-format stream-json \
  --replay-user-messages --include-partial-messages \
  --model fixture-model --tools "" --permission-mode bypassPermissions \
  --setting-sources "" --strict-mcp-config --mcp-config '{"mcpServers":{}}'
```

The tool-boundary case changes `--tools` to `Bash`. Its fixture tool signals that it started, waits for a fixture release file and returns a known successful tool result. The observer submits B/C after that signal and releases the tool after their stdin write. No running Delegatus or existing host is involved.

For reproduction, `PROBE` is the retained `observation-corrected.test.ts`, copied into the stage scratch directory, and `RUN` is a new directory beneath that scratch root. `GATE` is the stage's pinned, unmodified gate-slot wrapper. The fixture receives its own paths through environment variables:

```sh
CLAUDE=$(command -v claude)
mkdir -p "$RUN/home" "$RUN/config" "$RUN/tmp" "$RUN/state"
LLV_GATE_RUNNER=off LLV_OWNED_RUN_TIMEOUT_MS=240000 \
bash "$GATE" --record "$LOG" env \
  HOME="$RUN/home" XDG_CONFIG_HOME="$RUN/config" \
  TMPDIR="$RUN/tmp" LLV_STATE_DIR="$RUN/state" \
  LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1 LLV_CLAUDE_BINARY="$CLAUDE" \
  PROBE_ROOT="$RUN" PROBE_EVIDENCE="$EVIDENCE" \
  bun test --timeout=60000 "$PROBE"
```

The actual first command used `observation-first.test.ts`'s bytes, with a 240-second owned execution budget. Its combined, omitted-identity and delayed-response scenarios passed. Its tool scenario failed because the observer awaited B's echo while holding the tool that Claude had to finish before reading B. That is a fixture ordering error. The failed log and all its frames remain retained. The corrected command uses a fresh RUN, a fresh log, a 120-second execution budget and `-t tool-boundary`; it releases after stdin rather than awaiting that echo. The final check ledger records its outcome separately.

### Normal and delayed consumption: exact identity sequence

The supplied identities A/B/C/D are valid synthetic UUIDs ending in `000000000001`, `000000000002`, `000000000003`, and `000000000004`, respectively, with common prefix `00000000-0000-4000-8000-`. A says `fixture decision`; B/C/D say `fixture follow-up 1`, `2`, and `3`. R1/R2/R3 below alias distinct result-frame UUIDs.

The combined case writes A/B/C together, then writes D after the second result. Its complete relevant stdout order is:

| Ordinal | Frame | UUID / membership | Content |
| --- | --- | --- | --- |
| 1 | `user`, `isReplay=true` | A | decision |
| 2 | main `assistant` | `user_message_uuid=A`, plural `[A]` | response 1 |
| 3 | `result`, success | R1; singular A, plural `[A]` | first boundary |
| 4 | `user`, `isReplay=true` | B | follow-up 1; no timestamp field |
| 5 | `user`, `isReplay=true` | C | two text blocks: `fixture follow-up 1\n`, `fixture follow-up 2` |
| 6 | main `assistant` | singular C, plural `[B,C]` | response 2 |
| 7 | `result`, success | R2; singular C, plural `[B,C]` | combined boundary |
| 8 | `user`, `isReplay=true` | D | follow-up 3 |
| 9 | main `assistant` | singular D, plural `[D]` | response 3 |
| 10 | `result`, success | R3; singular D, plural `[D]` | final boundary |

Thus two replay echoes precede the one B/C result. The singular field names **C** in this observed combined batch. It cannot identify B. There is no B result. With caller UUIDs supplied, the plural result array gives usable identity evidence for both.

The delayed case holds the first API response until A's request arrives, writes B/C while that request is in flight, then releases it. It produces the same relevant stdout order and membership as the table. B/C enter stdin before R1; the API request containing them follows R1 because this scenario deliberately returns `end_turn` without a tool. In the recorded delayed run, B/C were written at 577 ms, R1 arrived at 676 ms, R2 at 715 ms; these are one-run ordering observations, without a latency claim.

The default-input case omits `uuid` entirely, matching today's broker. It yields a generated seed replay UUID, a generated **single** combined B/C replay UUID, then a generated D replay UUID. There is no standalone B replay in that run. Both singular and plural user-message identity fields are **absent** from its assistant and result frames. Generated result-frame UUIDs still exist. Default input therefore supplies no usable separate identity for B/C. The proposed change must actually send persisted input UUIDs; reading plural fields alone cannot fix today's broker.

### Two inputs at a running tool boundary

The corrected scenario passed at **11:36:50 UTC**. Its order, using the same aliases and milliseconds from child launch, was:

| Time | Observation |
| --- | --- |
| 9 ms | A written to stdin |
| 573–591 ms | API request 1, A replay, then assistant tool-use response with plural `[A]` |
| 710 ms | Tool-start handshake has completed; B and C written together; fixture tool released |
| 770 ms | Successful `tool_result` user frame with its own unrelated UUID |
| 777–778 ms | Separate B and C replay echoes, each preserving its supplied UUID |
| 794 ms | API request 2 contains the completed tool result, B, then C |
| 797 ms | Main assistant response 2; its envelope has **neither** user-message identity field |
| 826 ms | First terminal result: singular A and plural `[A,B,C]` |
| 834–893 ms | D written once, echoed, and completed by a second result with `[D]` |

Read-back of API request 2 put B before C (offsets 2,085 and 2,398 in that recorded JSON serialization). These offsets are a check of this fixture record. Both follow-ups reach the CLI and its next model request during the incumbent turn. There are three replay echoes and one incumbent result. Assistant-envelope membership is not consistently present across a tool continuation; use terminal membership for the completed batch contract.

The tool-boundary transcript records B/C as separate `attachment.type=queued_command`, `commandMode=prompt`, with `source_uuid=B` and `source_uuid=C`. Each attachment also has its own wrapper UUID and `delivery_id`; neither replaces `source_uuid` as the input identity. Reuse `claudeQueuedPromptUser` in `src/lib/claudeProtocolUser.ts:119`, which already normalizes this form. Exclude `commandMode=task-notification` and the unrelated `tool_result` UUID from prompt identity and terminal ownership.

### Identity retained in the native transcript

Read-only inspection of these fixture-created transcripts found a further explicit identity record. For both the combined and delayed cases, the canonical B/C user row is:

```json
{"type":"user","uuid":"C","mergedSendUuids":["B"],"promptSource":"sdk","message":{"role":"user","content":[{"type":"text","text":"fixture follow-up 1\n"},{"type":"text","text":"fixture follow-up 2"}]}}
```

Here B/C are the aliases defined above. The transcript has user rows A, C and D; B's standalone replay is not a separate durable user row. The omitted-UUID transcript has no `mergedSendUuids`. The stdout replay frame itself also omits `mergedSendUuids`, even when the transcript retains it. The new reader must distinguish those two evidence surfaces. The current `readClaudeTranscriptUsers` drops this explicit membership metadata and cannot recover B by identity.

**Decision:** use broker-assigned UUIDs, terminal plural membership and validated durable `mergedSendUuids` evidence. The installed CLI provides a usable per-input identity mechanism when UUIDs are supplied. The stop condition requiring `needs_decision` for a CLI without such a mechanism is therefore not triggered by these normal/combined observations. Native admission stays contained until the complete implementation matrix passes. Interrupted/error results, permission cancellation and crash-cut membership still require their own checks; success frames establish no guarantee about those branches.

## Identity and receipt contract

Use the existing `StructuredDeliveryQueue`, operation journal, delivery ownership records, file Claude delivery ledger, event store and inbox composition. Add native evidence to those owners. Introduce no second delivery queue or receipt service.

Four identities have different jobs:

| Identity | Producer and lifetime | Authority |
| --- | --- | --- |
| Original operation/idempotency key | Existing admission and `RuntimeJournal`; unchanged across executor replacement | Identifies the operator's instruction and its original receipt. An intentional new submission remains a distinct instruction even when its text is identical. |
| Native input UUID | Broker, generated once and persisted before possible stdin actuation | Identifies one native write. A Viewer-composed inbox entry can have several original members already bound to it before that write. |
| Replay/canonical frame UUID | CLI | Identifies that frame. The durable transcript may additionally name `mergedSendUuids`; stdout replay alone omits it. A combined frame's UUID supplies no independent receipt for its other constituents. |
| Result UUID and ordered `user_message_uuids` | CLI, scoped to the captured session/process/writer generation | Establishes the inputs consumed by that terminal CLI batch. A result UUID identifies the boundary; its membership array identifies consumed inputs. |

A supplied operation key is never interpreted as a native UUID. Native identity is broker-owned metadata, absent from public command bodies. `normalizeQueueEntry`, existing command parsing and immutable content digests retain their current responsibilities.

### Durable evidence before and after stdin

Extend the existing ledger records with optional, versioned native evidence. Preserve the readable `queued` and `delivered` record kinds and existing payload, image references, `parts`, origin, selected context and timestamps. The queued record must retain the assigned input UUID, session/generation binding, immutable content digest and a conservative write-intent marker. That marker means the input **may have reached stdin**. A crash between intent persistence and the write cannot prove non-delivery.

Generate and persist identity before the only write; repeat calls return the existing pending promise or evidence. An existing write intent restored from another process can never authorize another stdin write. A pristine operation refused before the intent is durable remains eligible for the existing ordered retry. A failed ledger append permits zero writes.

A native result proof records the actual result UUID, validated ordered input UUIDs, bound input entry IDs and the resulting turn owner before receipts resolve. A separate delivery proof may reference a canonical transcript row with explicit `mergedSendUuids`; that proves input consumption without inventing a terminal CLI result. Repeated delivery confirmations retain the first verified allocation. Durably recording the boundary before publishing its projected event lets replay recover a crash between those steps; use the existing event store and producer keys for idempotence. Retention cannot remove evidence while a delivery or its boundary is unresolved.

The first fsynced confirmation carrying a complete result proof is sufficient to replay any remaining member confirmations after a cut. Publish the terminal event only after its evidence is durable, and replay that event under the same producer key. A partially persisted set of member records must never become a partially forgotten native batch.

Keep the new I/O asynchronous under a labeled, bounded deadline. Serialize each host's intent appends, stdin writes and proof application without holding the queue's control lane. Do not put additional synchronous fsync/history scans into the stdout or Viewer request loop. Initialize from the persisted ledger off the loop; maintain only the active batch and at most two pending inputs in the broker's native index. Remove consumed entries after their proof/receipt is durable. Explicit recovery reads one conversation's ledger incrementally; no new global poll, whole-store cache or per-tick transcript scan is needed. Image content retains existing size bounds and references. This change claims no performance improvement.

An asynchronous intent append creates another pre-write race: recheck authorization, writer/process claim, permission state and attempt fence after the append and immediately before stdin. A proven zero-byte refusal after the append needs a durable no-write outcome under that same input identity before it may return to queued delivery. Failure to persist that outcome retains uncertainty. A failed/partial stdin write can never use the zero-byte-refusal path. Test both sides of this boundary.

Keep `engineMessageId` as the optional canonical transcript/replay-row identity. A result-only confirmation may have no individual canonical row. Store the native input UUID and result proof separately; assigning the combined frame UUID to every original entry would violate the ledger's current exclusive UUID allocation. `confirmedSend` must understand this stronger proof even when `engineMessageId` is null.

Native late confirmation must also recover the **turn reference**. The existing boolean `confirmedDelivery` port and `confirmJournalDelivery(..., {}, confirmedDelivery=true)` lose it. Add a typed evidence reader in the existing `confirmedSend` module, with the old boolean function as its compatibility projection. The native queue/controller and send-settlement confirmation paths use its validated generation and `turnId`, passing that turn through existing journal transition details. A consumed-input observation with unresolved turn ownership stays pending for final receipt settlement. Boolean-only observers may read established proof; none may create a new send. This is one evidence implementation shared by all callers.

Old records without native evidence retain contained behavior and the existing conservative content/time reconciliation. They acquire no invented native UUID on adoption. Unknown evidence versions are unverified. Disabling native admission in the new code must retain its new proof reader and write-intent fence. Historical binaries which ignore those fields cannot safely adopt unresolved native writes; an unsupported downgrade must not be presented as the kill-switch procedure. Acceptance covers restart/adoption with the new reader and disabling admission while native entries remain outstanding. Supporting older binaries across such a downgrade is deferred.

### Validation and combined frames

Only main-session, top-level evidence from the owned CLI stream is eligible. Check the current writer claim and process identity, exact session ID, valid UUIDs, bounded array size, uniqueness, outstanding membership and submission order. Reject a UUID allocated to another payload or generation. An omitted, empty, malformed, reordered, conflicting or partially unknown plural array supplies no native multi-input proof. A singular field cannot fill missing members of a plural array. Preserve existing fences for background work, subagent envelopes, compaction and stale results.

A standalone replay with the assigned UUID and matching immutable payload can record an input-specific echo. An echo confirms neither a whole native batch nor its turn ownership. A combined replay is retained once as a canonical item. Its joined text alone confirms no additional instruction. The terminal membership array can independently confirm each known native input, including an input with no standalone replay.

For a Viewer-composed entry, `bindDeliveryBatch` and `verifyBatchMembership` establish the mapping to original operations before actuation. A proof for that single native input then settles precisely those originals. Preserve the existing member receipts, content digests, image ranges and order; a later member cannot be attached to an already-written composition.

For CLI-combined independent writes, result membership proves consumption. For the observed durable canonical row, `[...mergedSendUuids, uuid]` explicitly identifies B/C; do not derive that mapping from concatenated text. Validate the full list against persisted input intents, session and order. The provenance adapter may expose parts only when this identity membership and the full ordered payload/block transformation are validated for that CLI version. Otherwise preserve the canonical item without an invented per-part author. Individual original receipts can use the validated native result or transcript membership proof. In particular, `claudeMessageProvenance` must not label an entire mixed combined row as its last input's author.

An interrupted/error result establishes only what the observed CLI contract actually acknowledges. The implementation acceptance must distinguish consumed, attempted and cancelled inputs. No blanket confirmation of every written input is allowed. Inputs absent from its authoritative evidence remain unconfirmed.

## Turn ownership and admission

Replace the assumption that each queued input owns one terminal result with an ordered set of written inputs plus one current CLI batch. The original turn reference remains stable for that batch. New input does not mint another running turn just because it was written or echoed.

At each validated result boundary:

1. Deduplicate the result against persisted evidence. A duplicate or older result cannot close a newer turn.
2. Validate membership against the ordered outstanding native inputs. Determine exactly which inputs this result consumed, including the incumbent when present.
3. Persist their result proof and boundary ownership. Resolve original receipts using that owner. An input joining the incumbent returns its incumbent turn reference; an input first consumed in a subsequent batch returns that batch's owner. Delay a final native receipt while that distinction is unresolved.
4. Emit one terminal event for the completed batch, with the CLI outcome. Remove **all and only** inputs consumed by that boundary. Retire its attention through the existing answer/cancellation path.
5. If previously written inputs remain, keep their custody and the next pending boundary. Start its stable turn owner from the oldest remaining entry, rather than from each replay. If nothing remains and no native background turn is established, become idle.

The critical examples are a seed result containing only A, followed by B/C echoes and one result containing B and C; and one result containing A, B and C after a running tool consumes both follow-ups. Also exercise an adversarial early B echo before A's result, without assuming that order occurred in the observations above. Neither echo count nor content-block count decides the number of turns. The seed boundary must leave B/C pending in the first example and clear the entire batch in the second. A later D is written once after completion and reaches a fresh terminal boundary.

Keep actual assistant activity and CLI result boundaries as the lifecycle evidence. An empty acknowledgement, provider quiet period, stdin callback, control response or missing replay cannot synthesize completion. A result with unresolved membership may establish an observed boundary without proving any original input's receipt; preserve that distinction and prevent idle from releasing uncertain writes for replay.

### Queue changes required together

Native admission must be an explicit, version-checked broker capability with a retained containment kill switch. Initially keep it disabled. Enable it only for a CLI version whose complete native acceptance passes. The installed version observation is evidence for its exact version; it establishes no lower bound or promise about future versions.

Use a broker-owned `nativeQueuedSend` option and `LLV_CLAUDE_NATIVE_QUEUED_SEND` setting: `0` forces containment, `1` requests native admission subject to the verified-version gate, and an invalid value fails closed. The first slice's default is disabled. The final acceptance slice may make absence mean enabled for its exact tested version set; initially that set can include 2.1.323 only after the remaining matrix passes. An unknown/missing version stays contained. Read the setting at host creation, preserve it in the host's capability decision, and do not forward it as a user-authored command or child permission. Changing an environment setting applies to subsequently created hosts; it authorizes no restart of an existing host. A detected evidence inconsistency immediately closes native admission in that host's own capability state.

The real-CLI acceptance must obtain the actual version from the installed binary and pass it through the fixture's existing auth/version observation. It must assert the native-enabled branch was exercised. A missing binary, null version, forced mock capability or silently skipped opt-in test cannot establish release acceptance. New CLI versions require renewed identity/lifecycle evidence before joining the version set.

The existing false `supportsQueuedSend` value restores the current split: seat/agent follow-ups wait for idle, and the existing bounded ordinary-operator join can remain available. It disables the new multiple-input admission. A generation whose own native evidence becomes uncertain must additionally hold that ordinary-operator active-turn path, so it cannot bypass the uncertainty fence. Preserve already-owned proof in both cases.

When enabled, allow writes during an active foreground turn for `queue`, the queue fallback of `steer-or-queue`, and ordinary operator `interrupt-active` sends. Maintain existing explicit Stop/interrupt semantics. Explicit turn fences, idle-only sends, runtime/account changes, authorization, seat ownership and release/drain barriers still apply. No new native send is admitted during a permission wait. Already-written inputs retain custody; permission answers and cancellation must remain serviceable.

Permit at least two pending native input writes after the incumbent, in durable submission order. Use a small fixed bound of two pending writes for the first implementation; overflow stays in the existing queued outbox until capacity is released. Keep current structured payload/image limits. A promise waiting for result evidence must release its queue lane; it cannot occupy the per-conversation control lane or block the second permitted input. Replace the broad `activeSteers` barrier only for these identity-bound native sends, retaining it for other engines and steering paths.

Retain current-seat `composeBatch` and its priority/membership policy. Its eligibility must no longer depend on native support being false. A bound composed entry can be written while the foreground turn runs, under an attempt-specific active-turn fence; the members' durable fences must not be rewritten into that transient observation. Revalidate every original member's authorization before dispatch. An entry already bound or written retains its original parts; late arrivals become another native input. This preserves #3934's receipt path and also covers two arrivals straddling adjacent queue passes.

Make that transient fence explicit as broker-local `QueueEntry.attemptTurnId`, excluded from normalized durable payload identity and public command parsing. The queue derives it from the observed active turn and the host rechecks it immediately before write intent. Keep genuine caller fences in `expectedTurnId` and preserve their existing policy interpretation. `composeBatch` currently supplies an idle `expectedTurnId=null` by default; the new active-batch path must replace that helper default with the members' actual caller constraint, rather than persisting an idle fence for a write into A. A pre-intent stale attempt returns to the original queued slot; an existing native intent is reconciled without comparing a later transient fence or writing again. Include omitted, null, named and moved-turn cases in the direct and composed acceptance.

Claude reads at its next supported boundary, such as completion of a tool call. Stdin delivery does not alter an already-issued Messages API request. The acceptance must hold the tool boundary, submit both follow-ups, and prove the next API request contains them **before the incumbent terminal result**. A pure generation which immediately ends has no earlier tool boundary; retain ordered delivery into its next CLI batch. The requirement supplies no reason to cancel a running tool or fabricate token-level preemption.

## Ambiguity and fallback

| Evidence at the point of uncertainty | Required outcome |
| --- | --- |
| Input never reached a write-intent boundary; version/capability unsupported, native capacity full, permission wait or pre-write fence changed | Leave the original operation queued. Use today's ordered after-turn path, including its existing composer queued presentation. Preserve its original payload and receipt identity. |
| Write intent exists; echo/result is missing or ambiguous | Preserve the original delivering/unknown evidence and prohibit a duplicate write. Stop new native admission for that generation. Reconcile through exact persisted input identity and owned native evidence. A timeout supplies no permission to resend. |
| Exact late proof exists | Use existing original-key reconciliation and the journal's `confirmedDelivery` arbitration. It can correct uncertain/failed receipt state only where the existing discard/migration-cancellation checks allow it. Never issue stdin during reconciliation. |
| No exact proof survives host loss | Leave the outcome visibly uncertain through the existing receipt controls. Continue unactuated work only through a proven new safe boundary and its original queued records. Never silently requeue this written input or report it delivered. |

Automatic after-turn fallback applies to **unwritten** inputs. An already-written ambiguous input cannot safely be delivered again after the turn. The current composer already distinguishes queued, handover and uncertain states; preserve those truthful meanings. Its original unknown receipt and payload remain visible; after-turn fallback requires proven non-actuation. This applies the acceptance's explicit prohibition on duplicate writes to its fallback rule.

Turning off native admission stops future active-turn writes. It neither clears outstanding proof nor retries written inputs. Do not use a capability rollback as a live recovery operation.

## Shared contract inventory and recovery

| Existing producer/consumer | Required integration |
| --- | --- |
| Composer/operator send, agent send/steer and initial launch send | Preserve admitted operation IDs, policy, origin, runtime settings and selected context. Unspecified native capability remains false. The broker alone assigns input identity. |
| `RuntimeJournal.executeOperation`, durable effects and `transitionOperation` | Preserve original operation admission, delivering CAS, replay keys, outbox slots, terminal uncertainty and confirmed-delivery arbitration. A result proof must settle original entries, without admitting replacement operations. |
| `StructuredDeliveryQueue` direct, native-during-turn and inbox-batch paths | All three use the same broker ledger evidence. Relax only the known native in-flight barrier; preserve pre-dispatch authorization, held migrations, original ordering and generation binding. |
| `QueueEntry`/`normalizeQueueEntry`, `composeBatch`, `bindDeliveryBatch`, `verifyBatchMembership` | Keep local attempt fences separate from durable caller fences; update the coalescing capability's after-turn-only comment for the new guarded active path. Preserve the original member manifest, including images, duplicate-reference semantics and offsets. No post-write membership changes. |
| Broker `send`, ledger load/record/confirm, event restore | Persist assigned UUID/write intent before stdin. Restore unresolved input custody. One durable result boundary replays idempotently after a persistence interruption. |
| Broker transcript adoption and `readClaudeTranscriptUsers` | Extend the reader to retain validated `mergedSendUuids`, canonical UUID, session and prompt subject. Native-enabled entries use their own persisted UUID and explicit canonical membership. A tool-result-only user record, summary or unmatched combined row cannot satisfy a prompt receipt. Legacy inference remains confined to legacy entries. |
| `confirmedSend` and its queue/controller/registry callers | For Claude, accept a validated native-input/result proof even without a standalone canonical row, retaining its turn owner. Keep original batch-member verification and generation binding. Codex retains its canonical-thread branch; unsupported engines still return false. Neither branch writes input. |
| `sendSettlement` receipt resolution/late confirmation, controller startup settlement, `runtime/http.ts` retry read and `externalRelay/ownerRun.ts` initial-message observer | Reuse the same typed proof and boolean compatibility projection. The first two propagate native turn ownership through `confirmJournalDelivery`; the retry path reads the original receipt before considering any new attempt. The owner observer only observes arrival and cannot settle/re-send an instruction. |
| `claudeMessageProvenance`, feed item and delivery-echo projection | Preserve canonical frame identity separately from native input identity; do not grant one frame to several exclusive UUID owners or lose original member authorship. A raw echo timestamp is not a final receipt. |
| Health, engine events, journal session projection, agent-state reconciliation | Use the same stable batch turn owner and actual boundary proof. All copies expose the same active/idle/unknown decision; no independent echo-based turn count. |

For a replacement queue executor or a Viewer transport restart with a surviving owned broker, read the delivering fence and exact broker proof; do not re-actuate. A dead executor's row can be settled from proof, or remain unverified. An unreadable claim never becomes a fresh dispatch.

The inspected main releases a Claude stdio host during Viewer demotion: `releaseStructuredDeliveryHostsForDemotion`, `handOverHostForDemotion`, broker `releaseAndReap` and `finishRelease`. A Viewer restart therefore cannot be described as universally preserving the same native process. Before adoption, respect the existing writer claim and release fence, recorded process start identity and complete captured process tree. A leader exit alone does not prove all writers or inherited pipes ended. Use the existing owned release/reap proof and process-identity checks, including refusal when the tree cannot be captured. Preserve any owed continuation separately from an original message receipt; a continuation is no evidence that the original input arrived.

After host death, reopen the existing journal and ledger and resume only through the supported adoption path. Preserve original input IDs and image references. New unactuated entries may proceed after a safe boundary. A possibly written entry without exact evidence remains unconfirmed and fenced. No automatic replay under a fresh operation ID is part of recovery.

## Parallel changes and implementation base

Before implementation, refresh main and PR #3934's exact state. If merged, build on main containing it. Otherwise merge that branch with a merge commit under the implementation stage's authority; retain its native test and verification history. This design stage performs no merge. Do not recreate its queue fixture, journal wiring, lifecycle assertions or member receipts. Forge comparison shows its inspected head is a merge with parents `2f2bb8ebd0851cd6a2676ea1c17ee39f94fe20ab` (the reviewed head) and `3c086dfc91aa650bfabe0417eaeaf74604745d3f`; neither owned test/document blob changed between the reviewed and merge heads. Renew that comparison when its head moves.

PR **#3975** was inspected at `a4c5c7cee5a4bcb0babf98a6c23a3945c4ff0cdf`. Its open diff overlaps semantically at these exact broker sites, measured in this design's source base:

- `claudeStreamBrokerHost.ts:1218`: send starts a turn; preserve its `agentStateTurnStartedAt` initialization while replacing per-input slots with batch ownership.
- `claudeStreamBrokerHost.ts:1444`: the new `reconcileAgentStateTerminal` currently calls `acceptResult` with singular synthetic identity. Native multi-input completion must require compatible full boundary/membership proof. An older transcript terminal or a tool-result UUID cannot close the new batch. Keep its writer and turn CAS checks.
- `claudeStreamBrokerHost.ts:1463,1731`: retain the stable logical batch turn owner and expose its validated native prompt/membership binding. A canonical C row with explicit merged B membership can identify the B/C batch; B's earlier replay alone cannot supply that binding. A tool-result or attachment-wrapper UUID cannot overwrite it. Joined B/C command attachments retain the incumbent A prompt anchor.
- `claudeStreamBrokerHost.ts:1915`: its post-result timestamps/native ID must derive from the next actual unresolved batch; copy neither the old slot-shift logic nor a phantom turn.

In `structuredDeliveryController.ts:2991–3040`, #3975 adds active/background settling before demotion and stops its state service. Preserve that work. Its event wait must see the one terminal event for the actual batch and keep waiting while another already-written batch is active. Freeze new admission under the existing handoff fence, so a drain cannot extend forever through new sends. The result-membership/agent-state adapter requires joint review with #3975; the queue changes at 1866/2393/2425/2666 are outside its controller hunks.

Other inspected open diffs touching these files are #3802/#3749 (final spawn authorization), #2926 (managed process/signal ownership), #3668 (dispatch authorization context), and #3355 (legacy Codex native-queue replay). Preserve their guards. Their hunks do not supply Claude multi-input identity. The dictation lane is outside this path.

## Acceptance matrix and failure controls

Extend `claudeStreamBrokerHost.nativeQueue.test.ts` from #3934. Keep real `ClaudeStreamBrokerHost`, `StructuredDeliveryQueue`, `RuntimeJournal`, file ledger and event projection around the installed binary. Transport-seam injection is useful protocol evidence; it cannot replace the broker/admission acceptance or manufacture receipts for inputs the broker never sent.

| Case | Required observation | Broken branch that must make it fail |
| --- | --- | --- |
| One mid-turn input, ordinary conversation and current seat | Stdin write during a held running tool; next model request includes the input before the incumbent result; successful tool output and zero implicit interrupts | Keep idle-only seat admission, or interrupt the tool |
| Decision then B/C quickly, same pass and adjacent passes | Both writes/composed members reach the CLI before release of the tool; the next API request includes B then C before the first terminal result; original receipts survive | Keep the one-pending guard or broad unsettled-handover barrier |
| Combined replay, with and without standalone echoes | Supplied identities survive; result membership confirms each exact input; one canonical frame never confirms several by text | Drop plural membership parsing or assign the last frame UUID to every entry |
| Early B echo, A result, then B/C result | A ends alone; B/C stay owned until their own result; no phantom turn after it | Remove B on its early echo or shift one slot per result |
| Repeated batches and a subsequent D | Multiple batches end with matching journal/host state; D reaches stdin once; replayed operation IDs add zero writes | Fail to remove all consumed members, or re-actuate delivering effects |
| Delayed consumption, same text, missing/late echo | No content-based cross-allocation, premature receipt or deadline-based resend; exact late proof corrects the original receipt | Re-enable content inference for native entries or treat timeout as failure safe to resend |
| Text/image and image-only inputs, including composed parts | Original bytes reach the loopback API, references/digests survive journal/ledger reopening and receipts stay original | Lose an image range, substitute digest or reconstruct content from joined text |
| Permission allow, deny, explicit cancellation; sends during attention | Control path remains live, no implicit answer/interrupt; new data waits while attention is pending; receipts reflect exact observed consumption | Let pending native sends occupy the control lane or confirm all written IDs on cancellation |
| Explicit interruption and API/CLI error | Distinguish each consumed/attempted/cancelled ID; one actual terminal boundary; unconfirmed writes stay fenced | Clear the native outstanding set on interrupt acknowledgement or blanket-confirm an error batch |
| Replacement executor; Viewer restart with and without surviving broker | Read original receipts and owner proof; actual successor process; no duplicate writes or made-up continuation receipts | Remove delivering CAS/claim checks or infer delivery from restart success |
| CLI-host restart at intent-before-write, after-write/before-echo, between echo/result, after-proof/before-journal | Restore the same durable journal/ledger identities and images; uncertain cases do not write again; persisted proof repairs only its own original receipts | Treat restored queued ledger rows as permission to send, or invent UUIDs on adoption |
| Wrong session/process/claim, duplicate/unknown/out-of-order arrays, old/repeated result | Refuse conflicting proof and preserve current turn/receipt; no second write | Validate text alone, ignore generation, or accept singular identity as a whole array |
| Native disabled/unsupported version, capacity overflow | Current contained seat/agent behavior and bounded ordinary join; queued UI for deferred unactuated inputs; new reader retains prior native intents/proofs. Uncertain generations hold all further active-turn writes | Admit multiple native inputs while disabled, let ordinary-operator admission bypass uncertainty, or discard the new write-intent fence |
| #3975 reconciliation and demotion, background/compaction/subagent frames | Older or different-subject terminal cannot close a native batch; release retains all owned work/proof | Pass a synthetic singular result through the new multi-input reducer |

Interruption/error/cancellation membership and restart transcript identity require their own real-CLI observations. Success on normal terminal arrays alone does not enable those paths. If any branch lacks usable per-input evidence, keep that branch contained or unknown after actuation and state its limit explicitly.

Run each lifecycle test file in its own owned runner, sequentially. Every run gets fresh `HOME`, `XDG_CONFIG_HOME`, `TMPDIR`, `LLV_STATE_DIR`, a loopback port-0 API, synthetic local authentication and a closed Viewer control URL. Attach socket-error handlers before writes in fixture-owned listeners; an abandoned peer must not crash the listener. Do not alter a production listener or add harness handlers that hide a missing product error handler.

Implementation checks, each through the pinned `scripts/gate-slot.sh` wrapper, are `bunx tsc --noEmit`, changed-file ESLint, and explicit paths under `src/lib/runtime/` for the native file, `claudeStreamBrokerHost.test.ts`, `structuredDeliveryQueue.test.ts`, `structuredDelivery.integration.test.ts`, `sendSettlement.test.ts`, `structuredDeliveryRebind.test.ts`, `claudeMessageProvenance.test.ts`, and touched journal/restart tests. Run additional #3975 reconciliation/demotion tests only by their explicit filenames after integration. Complete the publication privacy gate and unmodified pre-push hook on the final implementation commit. Preserve failed logs and actual cleanup receipts. No full directory sweep is authorized by this specification.

No new composer state or string is required. Verify its existing queued/handing-over/uncertain/delivered states through the conversation-window browser driver and existing phone driver in English/Ukrainian and both themes. Include ordinary conversation and seat delivery, text and image payloads, at the driver's desktop/phone widths and intermediate widths where relevant. Keep original operation identifiers in the receipt evidence and compare ingress, admission, engine evidence and presentation. A green protocol test alone cannot establish visible fallback.

## Delivery slices

Prefer one implementation PR after integrating #3934, because receipt identity and turn ownership must change together. If review size requires two PRs, the only safe split is:

1. **Evidence and durable reducer, admission disabled.** Add native input identity, proof parsing/replay, original-key reconciliation, provenance safeguards and result-based batch ownership as one contract. Keep current admission and old-record behavior. Exercise fake hostile frames and installed-CLI evidence, with the full operator case as a required prospective acceptance. Record each operation's input identity, write intent, echo identity/time, result membership/owner and final receipt, including no-echo and no-result cases. This slice alone leaves the operator's two-message seat case waiting and does not claim the task complete.
2. **Admission and final acceptance.** Enable the verified capability, seat batching during a turn and two pending native writes; narrow the queue barrier without blocking controls. Retain the kill switch and run the complete real-broker matrix, restart variants, #3975 integration and rendered fallback. The decision/B/C case must now reach the next tool boundary before the incumbent result. Admission cannot ship before the first slice's complete identity/ownership contract.

Every intermediate release retains a working fallback. Neither slice removes a receipt fence, native-subject guard, turn-ended signal, cancellation path or image/member binding without replacing it in that same slice. Review budget: three rounds for this critical delivery path. Claim correctness only after the operator's repeated case passes; clearer errors or ordered delivery after completion alone cannot close the originating requirement.

## Deferred — not currently justified

- Token-level interruption of an in-flight model request, forced tool cancellation, and provider/API changes.
- Production recovery, replay or clearing of previously ambiguous instructions, and agent controls against existing sessions.
- Dictation repair and unrelated agent-state policies owned by other lanes.
- A replacement queue, receipt database, universal multi-engine batching framework, new composer workflow, or an additional issue-specific browser/probe driver.
- Broad performance claims, new telemetry stores, and protocol support for CLI versions without recorded identity/lifecycle evidence.
- Downgrading unresolved native delivery state to historical binaries without the native proof/write-intent reader. The supported kill switch retains that reader.

## Stage verification

At **2026-11-13 12:01 UTC**, remote main and the assigned HEAD still equal `4931ed1da00ca71aa3dba8ca939c7cc662bcc27e`; #2742, #3934 and #3975 remain open at the heads recorded above. The installed CLI version and binary digest were rechecked and unchanged. The only assigned-checkout change is this document. No commit was created.

Every lifecycle command below used one explicit test file, fresh isolated state, the pinned unmodified gate wrapper and one owned runner at a time. Each recorded run was joined once through `wait_for_check` to its terminal command/cleanup receipt. The failed first run was not adopted as a successful receipt.

| Retained log | Command after wrapper and isolated environment | Actual outcome |
| --- | --- | --- |
| `identity-observation.log` | `bun test --timeout=60000 "$PROBE"` | Exit **1**; 3 pass, 1 fixture-order failure, 5 assertions; 28.17 s execution. Normal, omitted and delayed identity cases passed. |
| `tool-boundary-corrected.log` | Same command with `-t tool-boundary`, fresh roots and corrected observer | Exit **0**; 1 pass, 3 filtered, 5 assertions; 1.468 s execution. Both follow-ups precede the incumbent result. |
| `native-pr3934.log` | `bun test --timeout=60000 --cwd "$EXPORT" src/lib/runtime/claudeStreamBrokerHost.nativeQueue.test.ts` | Exit **0**; 11 pass, 0 fail, 305 assertions; 32.21 s execution. |
| `pre-push-design.log` | `bash .githooks/pre-push`, with `LLV_GATE_EXECUTION=local` and `LLV_SKIP_HOOKS=0` | Exit **0**. Unmodified hook ran once, privacy passed; its prose-only plan skipped types, lint and touched source tests. |
| `privacy-document-handover.log` | `bun "$EXPORT/scripts/privacy-publication-gate.ts" --repository "$CHECKOUT" --require-known-values --paths docs/design/claude-native-queued-send.md` | Exit **0**, full-document privacy scan, zero findings. |
| `whitespace-verification.log` | `git diff --no-index --check /dev/null docs/design/claude-native-queued-send.md`, with its expected added-file exit checked | Git exits **1** for the added-file difference and emits no whitespace diagnostics; the verifier exits **0**. This checks the untracked output's actual contents. |

The native test was copied without modification from #3934's inspected diff into the source export. Its SHA-256 is `2c43bf857c0e01b8f8b76eafafbd612d041a4b24eb087b13dd42e549f4a05981`. The broker, queue, journal and event-projector source bytes in that export were compared with the assigned baseline and match. Its eleven cases establish current contained delivery and the existing one-input operator join; they do **not** establish the proposed native-enabled matrix or a real Viewer-process restart. Those are build-stage acceptances.

The original observer SHA-256 is `b3305d6fc5ef9c833defe353a4b0fc9e77b691ff4bc65d0c7a9d7bbf3e41957e`; the corrected observer is `a39e6c14380ae17241b9c9a6c41fff07fee7d939967275d85ad056dfd4f7187c`. Normal probes terminate their own CLI after its last successful result; their child termination code 143 is intentional cleanup, distinct from the test command's exit. Frames, fixture transcript identity extracts, scripts, terminal receipts and a digest manifest remain in the retained evidence directory. They are not additional repository outputs.

The pre-push invocation used a separate detached scratch copy of the unchanged HEAD, with a document snapshot present, private HOME/config/temp/state, and no Cloud execution. The stage's explicit no-commit fence prevents checking a final design commit here. That hook invocation cannot certify the later commit that the engine records. The final document is checked separately in full; publication must run its normal hook on its recorded commit. No typecheck, source lint, build or full suite is claimed for this document-only stage. The implementation checks listed above remain mandatory for the build stage.

**Design verdict: pass.** Usable per-input identity exists on the observed CLI when the sender supplies UUIDs. Implement its identity/receipt and result-boundary contract together, integrate #3934, resolve the named #3975 overlaps, and keep native admission contained until the full matrix passes.
