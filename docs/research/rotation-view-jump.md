# Rotation view jump and mandate misclassification

Originating requirement, 2026-10-10 approximately 07:50 Kyiv, operator voice report in Russian, verbatim:

> «Почему сначала показывается мандат, потом показывается оркестратор старый? Это я ротацию сделал. То есть он почему-то вернул меня на старый. А потом, когда я снова вернулся к оркестратору, уже сам кликнул ещё раз. То он уже подтянул, только теперь уже не показывается мандат, а показывается вот это сообщение, как будто это от меня отправлено.»

## Conclusion and scope

Two independent client-visible defects explain the sequence:

1. **P1: rotation commits a temporary phone focus without committing navigation and conversation identity.** The conversation-menu landing changes only `MobileFocusView`'s local path. The navigation stack still names the predecessor. When the successor's `spawn:` window becomes its transcript, its pinned path disappears. The generic attention/freshness fallback can select the predecessor while its final turn is still running. The existing launch-adoption mechanism handles ordinary draft launches, and seat openings bypass its registration.
2. **P1: Claude's durable message provenance omits mandate metadata.** The real first delivery has an admission-stamped `operator` origin. Its delivery occurrence correctly carries mandate v44, but the UUID lookup returns the incomplete message provenance first. The renderer consequently produces a user bubble. Temporary launch metadata supplies the initial card; its retirement and the browser's settled provenance cache expose and retain the wrong classification on reopen.

The required behavior is to retain the successor's conversation through rotation and transcript adoption, and to classify its delivered mandate by durable delivery identity on every opening. The existing mandate card and its rotation-handoff disclosure supply the requested UI. This investigation changes only this document. Implementation, new regression tests, and new rendered evidence belong to the subsequent fix stage.

Code references below describe main at `39f654248666faa6e5deb01d59eeae305e64573f`. Real records were inspected read-only; SQLite connections used `mode=ro`. Live conversation and launch identifiers are replaced with the aliases below, following the local privacy gate. Account identities, machine home paths, mandate contents, and credentials are omitted.

## Incident evidence

The two conversations are the old and new conversation IDs named in the pinned incident specification. Resolve their native transcripts through the registry's current generation paths. This document uses these publication aliases:

- Predecessor: the specification's old conversation; transcript `<predecessor-session>.jsonl`.
- Successor: the specification's new conversation; transcript `<successor-session>.jsonl`.
- Successor launch: `<successor-launch>`; the active seat's `intent.launchId`.

`$STATE` below means the installation's state root. Native transcript references mean the generation path recorded in `agent-registry.sqlite`, rather than a same-named normalized transcript. Paths to screenshots remain local reference pointers.

| UTC time | Read-only record | Observed fact |
| --- | --- | --- |
| 04:46:58.661 | Predecessor native transcript, line 3524 | A seat-tick message starts the predecessor's last turn before the rotation. |
| 04:46:59.628 | `$STATE/orchestrator-seats.json`, active successor `designatedAt` | Successor designation, epoch 24, prompt version 44; its `intent.clientRequestId` identifies the rotation request. |
| 04:47:00.380 | `$STATE/agent-registry.sqlite`, `registry_rows`, `receipts`, successor launch | A root launch, delegation depth 0, orchestrator role. Its retained launch display has a 30,352-character prompt and 31,090-character echo. |
| 04:47:00.488 | Seat record `activatedAt`; predecessor revocation `revokedAt` | Successor becomes active; revocation names the same predecessor and successor. The retained record contains no rollback to that predecessor. |
| 04:47:03.916 | Registry `heldDeliveries`, successor's first delivery | First delivery reserves `spawn_<successor-launch>` and stamps `command.origin.kind = operator`. |
| 04:47:04.110 | `$STATE/claude-delivery-ledger/<successor-session>.jsonl`, line 1 | Queued entry `spawn_message_<successor-launch>`, with `origin.kind = operator`. |
| 04:47:04.130 | Successor native transcript, line 3 | SDK user record with its own UUID, 31,090 characters. `promptSource` and `turnOrigin` are `sdk`; entrypoint is `sdk-cli`. It carries no mandate text marker. |
| 04:47:05.742 | Held delivery `deliveredAt`; delivery ledger line 2 | Delivery completes; ledger binds the exact entry to that transcript UUID. |
| 04:47:18.075–18.902 | Predecessor native transcript, lines 3551–3552 | `deploy_exact_sha` is refused because this conversation no longer holds the designated seat. Authority revocation works. |
| 04:47:22.169–22.547 | Predecessor native transcript, lines 3558–3559 | `get_orchestrator` reports the correct successor at epoch 24. |
| 04:47:41.696–42.485 | Predecessor native transcript, lines 3564 and 3569 | Predecessor sends the successor a handoff message. |
| 04:47:50.084 | Predecessor native transcript, line 3571 | Its final assistant turn acknowledges the rotation and refused deployment. It continued writing after revocation. |

The brief labels the transition 23 → 24. The retained revocation for this exact predecessor records `seatEpoch: 22`; the retained successor records 24. There is insufficient retained history to reconstruct that numerical discrepancy. Conversation IDs, matching revocation time, successor lineage, and the predecessor's own tool results establish the transition used here independently of that label.

All three screenshots were inspected as images:

- `$HOME/Projects/delegatus-wt/handoff/rotation-view-bug-20261010/1.png`: successor's initial “Мандат v44” card, “Передача при ротації”, seat-creation timestamp 07:47:00, and pending host/first-message state.
- The same directory's `2.png`: predecessor's release-report transcript is visible again.
- `3.png`: successor is working, with a 31,090-character operator-style bubble beginning “You are the Orchestrator…”, followed by agent/tool activity; the mandate card is absent.

The canonical digest of the successor's first message, computed using the existing `{text, images: []}` delivery digest format, equals the retained held delivery's `contentDigest`. Thus the visible giant bubble is the delivered mandate, rather than another operator submission. The mandate text and digest are unnecessary publication data and are omitted.

No browser event trace from the incident was retained. The server records establish rotation and the predecessor's continued activity; the screenshots establish the observed view sequence. The exact browser poll or predecessor write that caused the switch is inferred from the code and the deterministic replay below.

## Cause 1: the successor landing loses its identity

### Server rotation and authority

`rotate_orchestrator` dispatches `/api/orchestrator/rotate` with a new seat intent (`src/lib/mcp/bindings.ts:5036`, `:5060`). The HTTP route calls the shared seat command (`src/app/api/orchestrator/rotate/route.ts:44`). The command activates the accepted durable conversation even when its transcript path is still null (`src/lib/orchestrator/seatCommand.ts:1313`–`:1321`).

`completeOrchestratorSeatIntent` revokes the differing incumbent and writes the successor in one account mutation (`src/lib/orchestrator/seats.ts:878`, `:899`–`:918`, `:931`–`:946`). A path-pending spawn retains an explicit rollback candidate (`:925`–`:929`); that mechanism does not explain this incident's successfully materialized successor and unchanged designation. Authority projection stamps registry identity (`src/lib/orchestrator/seatCommand.ts:575`–`:590`). These steps publish seat state; they do not navigate a browser or terminate a predecessor's current turn.

The real predecessor's refused deployment and subsequent `get_orchestrator` result confirm the authority change. Its final turn can finish safely while the operator remains on the successor. Killing that turn would mask the client defect and violate the requirement.

### The phone has two different selections after rotation

`MobileFocusView` stores a path in local `focusState` (`src/components/mobile/MobileFocusView.tsx:232`–`:235`). Its seat key is resolved through the active seat's durable conversation ID to a layout node (`:426`–`:431`). For an armed rotation, the effect waits for a different renderable seat, closes the sheet, disarms the handoff, and calls only `setFocusPath(seatKey)` (`:499`–`:509`). It calls neither the navigation replacement nor the parent `onSelect` opener.

Ordinary sibling switching already updates the top chat entry with `nav.replace({kind: "chat", id: entry.key})` (`src/components/mobile/MobileFocusView.tsx:458`–`:474`). The rotation effect bypasses that part of the established navigation contract.

The enclosing dashboard treats the top navigation entry as the phone's selected conversation (`src/components/ProjectDashboard.tsx:1834`–`:1838`) and passes it back as the focus prop (`:2506`–`:2513`). A remount initializes from that stale predecessor entry. While the component remains mounted, the local successor path can temporarily conceal the disagreement.

### Transcript adoption removes the temporary path

Launch projection names a provisional file `spawn:<launchId>` (`src/lib/agent/spawnProjection.ts:562`). On materialization it folds launch facts into the transcript and stops emitting that placeholder (`:485`–`:499`). The durable conversation remains the same; the board key changes.

The dashboard already knows how to follow this change: `mobileLaunchSuccessor` looks up the provisional path's conversation ID, finds its current transcript, and replaces the navigation entry (`src/components/ProjectDashboard.tsx:1843`–`:1856`). However, `launchedConversations` is populated only in `draftSpawned` (`:568`–`:571`, `:1494`–`:1500`). Seat creation/rotation does not use that callback.

This also affects the board's seat opener. `MobileSeatCard` calls `onOpenConversation(file)` on an armed successor landing (`src/components/mobile/MobileSeatCard.tsx:465`–`:473`); `openBoardRow` places the file and opens its path (`src/components/ProjectDashboard.tsx:1709`–`:1711`). Neither registers that provisional seat's durable conversation in the adoption map. A board-origin landing can therefore update navigation initially and still lose the successor when the placeholder is retired.

If the pinned path disappears, `MobileFocusView` selects the highest-scoring remaining node by pane state and transcript mtime (`src/components/mobile/MobileFocusView.tsx:300`–`:313`). There is no retained conversation-ID resolution at this boundary. The predecessor's continuing writes make it eligible to win that fallback. This is why a successfully rotated server seat can coexist with a phone showing the old orchestrator.

### Other navigation candidates checked

- Seat polling publishes status; it does not implement a global follow-the-seat policy (`src/components/orchestrator/useOrchestratorSeat.ts:14`, `:131`–`:140`). The rotation effect is armed for one operator gesture and disarms after landing (`src/components/mobile/MobileFocusView.tsx:504`–`:515`), so it cannot repair a later path change.
- Desktop's orchestrator panel resolves the designated durable ID and rejects stale incumbent metadata belonging to a different conversation (`src/components/orchestrator/OrchestratorPanel.tsx:252`–`:271`). No evidence requires redesigning that resolver.
- The phone withholds the attention device ID and does not accept focus requests (`src/components/attention/AttentionHost.tsx:30`–`:34`, `:149`–`:153`). The predecessor's relevant transcript contains no `request_attention` call; the retained attention store has no request from this incident window. Attention authority also refuses revoked seats before writing a request (`src/lib/mcp/bindings.ts:6380`–`:6394`).
- Explicit selected-conversation requests consume a nonce once (`src/components/ProjectDashboard.tsx:1214`–`:1237`). Viewer clears a resolved hash intent (`src/components/Viewer.tsx:889`–`:905`) and clears stale pending intent on deliberate focus (`:1094`–`:1109`). These paths do not explain an automatic repeat selection of the predecessor in this sequence.

### Deterministic reproduction on main

An isolated DOM replay mounted the actual `MobileFocusView`, with network/log-tail responses stubbed and both seats present. The seed represented the rotation effect's resulting state: local focus on `spawn:successor-launch`, navigation top on the predecessor. Replacing that placeholder with the successor transcript under the same durable conversation ID, then publishing a newer live predecessor write, produced:

```json
{"step":"rotation landing","title":"Successor","navTop":"/sessions/predecessor.jsonl"}
{"step":"transcript adoption and predecessor write","title":"Predecessor","navTop":"/sessions/predecessor.jsonl","successorStillPresent":true}
```

This proves the identity-loss route in the real component. The replay does not claim to recover the operator's absent navigation telemetry or the exact timing of screenshot 2.

### Minimal fix

1. In the armed rotation landing, replace the top chat entry with the successor's board key using the existing sibling-switch semantics. Also call the existing parent selection/opening path for the actual successor file, and set local focus. Perform the handoff once; preserve the entry beneath the replaced chat.
2. Move provisional-file registration into the common file-opening path, currently `openSwitchboardFile` (`src/components/ProjectDashboard.tsx:1615`). Register `spawn:` path → durable conversation ID for every provisional seat open, including the conversation-menu landing and `MobileSeatCard`'s board landing. Reuse `mobileLaunchSuccessor` and its existing transcript adoption; remove redundant draft-only registration as appropriate.
3. Preserve the selected successor during the scanner's provisional-to-transcript transition. Resolve by the registered durable identity before generic fallback; an intermediate scan gap must retain the selected window/loading state. Update navigation and the focus passed to the child in the adoption render so no predecessor frame is painted.

Acceptance: after the operator's rotation gesture, local focus, top chat entry, and visible conversation agree on the successor through transcript materialization, polling, a remount, and reload. Later deliberate navigation still works. The predecessor remains available in history and may finish its revoked turn. A passive seat-status poll must not override a later operator choice.

## Cause 2: exact message provenance drops the mandate

### The durable recognizer is delivery identity

The native SDK row supplies an engine message UUID, rather than an in-text mandate marker. The parser recognizes an SDK-delivered record and preserves that UUID in `deliveredMessage.engineMessageId` (`src/lib/claudeProtocolUser.ts:99`–`:106`; `src/components/feed/parse.ts:3246`–`:3257`). “You are the Orchestrator…” is content and cannot safely distinguish a mandate from an operator paste.

Seat delivery recognition already exists in `orchestratorMandateDeliveries` (`src/lib/runtime/deliveredMessageOccurrences.ts:108`–`:122`):

- `orchmandate_<seat-intent-id>` is the reserved existing-conversation adoption identity. The prefix recognizes a mandate even when its qualifier is unavailable (`:134`–`:140`).
- `spawn_<launchId>` is a generic first-delivery identity. A recorded seat launch is required to recognize it as a mandate. Current, pending, and historical seat records provide the version/custom qualifier.
- Claude's ledger operation uses `spawn_message_<launchId>`; the delivery-owner record associates that operation with its client message ID. The ledger's delivered record associates the operation with the native UUID.

`heldDeliveryOccurrences` attaches the recognized mandate independently of the stamped origin (`src/lib/runtime/deliveredMessageOccurrences.ts:163`–`:181`). The real successor's matching occurrence is `{origin: "operator", mandate: {kind: "version", version: 44}}`. Its delivery identity and digest remain available even though the delivered held text has been scrubbed.

### The stronger UUID answer lacks the semantic field

A depth-zero root launch receives `operator` origin in `spawnMessageOrigin` (`src/lib/runtime/structuredSpawn.ts:1801`–`:1808`). `defaultDeliverFirst` queues that stamp with the two IDs above (`:1811`–`:1822`). This generic origin rule also applies to the actual successor seat.

`claudeMessageProvenance` joins the ledger to the transcript UUID. Its `entry.origin` branch returns origin, submission, channel/context and sender fields, with no seat-mandate lookup (`src/lib/runtime/claudeMessageProvenance.ts:69`–`:86`, `:125`–`:134`). Its legacy depth-zero spawn fallback also returns only `operator` (`:33`–`:51`).

The provenance route returns both maps in a `no-store` response (`src/app/api/log/provenance/route.ts:67`–`:78`). The client gives `messages[engineMessageId]` unconditional precedence over occurrence assignment (`src/components/feed/messageProvenance.tsx:406`–`:411`). Thus the correct occurrence's `mandate` is never consulted for this real row. `resolveDeliveredItem` tests `.mandate` first, then converts `origin: operator` into a user item (`src/components/feed/FeedItem.tsx:76`–`:87`).

### Why the first opening looks correct and reopening does not

The confirm response builds a provisional file with mandate metadata (`src/components/orchestrator/useSeatConfirm.ts:70`–`:96`). The files response also enriches seat launch prompts through the seat lookup (`src/app/api/files/response.ts:291`–`:305`; `src/lib/agent/spawnProjection.ts:176`–`:182`). This explains screenshot 1 before the transcript takes over.

On materialization, `launchFactsWithoutPrompt` deliberately removes both prompt and mandate from transient launch facts (`src/lib/agent/spawnProjection.ts:192`–`:202`). Full-catalog opening hydrates conversation rows through a different projection and cannot depend on those launch facts (`src/app/api/conversations/route.ts:76`–`:85`). A reload likewise loses the provisional client snapshot.

The held mandate cache is bounded, in-memory, and keyed by conversation (`src/components/conversation/heldMandate.ts:23`–`:36`). It bridges launch retirement and first-record timing. Once the first matching record has **any** provenance, `holdsMandate` stops substituting the held card (`src/components/LogFeed.tsx:1307`–`:1336`, specifically `:1328`; substitution at `:1520`–`:1523`). The incomplete UUID answer therefore defeats even a retained held card.

The browser-wide provenance cache further stabilizes that error. It survives pane remounts (`src/components/feed/messageProvenance.tsx:144`–`:149`); `unresolvedDrivers` treats an existing UUID entry as settled (`:365`–`:374`), and a settled cache can suppress another read on reopen (`:531`–`:541`). A fresh page still receives the same incomplete server answer. First-record arrival, metadata arrival, catalog hydration, and launch retirement change when the error becomes visible; the missing durable `.mandate` field determines its final classification.

A cold open has a further timing edge to cover with the same fix: before the first provenance answer there is no held card. The native-record waiting guard currently returns early when no pending outbox exists (`src/components/LogFeed.tsx:1480`–`:1489`, specifically `:1482`), and an unresolved `sysmsg` renders a system card (`src/components/feed/FeedItem.tsx:191`). Correcting the server's final answer alone would leave this temporary wrong card shape on a cold catalog open. Use the existing evidence-pending guard to wait for classification before presenting the native delivery row.

### Real-record reproduction on main

An isolated replay supplied the real successor's first native record, delivery-ledger entries, scoped read-only registry snapshot, and seat record to the existing producers and renderer: `claudeMessageProvenance`, `heldDeliveryOccurrences`, `orchestratorMandateDeliveries`, `buildFeed`, `provenanceLookupFor`, and `resolveDeliveredItem`.

| Input evidence | Parsed kind | Resolved kind | Matched occurrence |
| --- | --- | --- | --- |
| Real occurrences alone | `sysmsg` | `mandate`, v44 | `operator` origin plus mandate v44 |
| Real UUID messages plus the same occurrences | `sysmsg` | `user`, 31,090 characters | The same correct mandate v44 occurrence |

The second row is the endpoint's actual evidence shape. Adding its stronger UUID evidence turns the correctly recognized mandate into the wrong user item. This reproduction requires no inferred browser timing.

### Minimal fix

Enrich **Claude's UUID provenance producer** with mandate metadata using the exact ledger entry's delivery identity:

1. Resolve the entry's client message ID from `deliveryOperationOwners`; for the established first-launch operation format, use the existing `spawn_message_<launchId>` → `spawn_<launchId>` identity relationship as the legacy fallback.
2. Reuse the seat delivery map and the reserved-adoption recognition rule from `deliveredMessageOccurrences`. Read the registry snapshot and seat map once per provenance call. An optional seat-record dependency follows the producer's existing test seams; a small shared recognition helper is sufficient.
3. Append `.mandate` to the UUID answer for a recognized delivery, including the early stamped-origin branch and legacy spawn fallback. Keep its exact authorship/submission fields. The renderer already prioritizes `.mandate` and will produce the existing card.
4. Apply the existing `messagePending` guard to unresolved SDK delivery rows during their first evidence read even without a pending outbox (`src/components/LogFeed.tsx:1480`–`:1489`). Preserve the known held card when available; a cold opening can show the normal loading state until that read answers. Preserve the existing bounded settlement behavior for genuinely unclassified records.

This corrects the real records on the next fresh evidence read and survives cold catalog opens and reloads without retaining launch prompts. The updated application bundle naturally clears the old in-memory cache. Preserve held-card behavior during first-record/evidence delays; test the enriched producer's output through the cache and feed rather than manufacturing a correct client response. Once the mandate row is presented it must have the card shape, and a displayed card must never be replaced by a system or operator row.

Do not weaken UUID precedence by globally preferring digest occurrences. A later operator paste can contain identical words, especially in a cropped tail. Delivery identity must keep that paste as an operator message. The prefixes, seat evidence, and operation-to-UUID join already provide the required distinction.

The handoff section needs no replacement UI. `MandateCard` receives the mandate qualifier and splits the delivered text with `mandateMessage` (`src/components/feed/cards/MandateCard.tsx:35`–`:67`; `src/components/feed/mandateMessage.ts:17`). Keep the existing handoff heading and delivered text intact so the rotation disclosure remains present.

## Focused regressions required in the fix stage

Use synthetic conversation/launch identifiers and a short mandate containing a handoff section. Do not copy the live mandate, private release reports, account labels, or machine paths into fixtures.

| Existing test file to extend | Regression and assertion that fails on main | Required passing behavior |
| --- | --- | --- |
| `src/components/mobile/MobileFocusView.conversation.dom.test.tsx` | Rotate through the actual conversation menu; publish a different active seat backed by a provisional file. Assert the top chat entry becomes the successor. Main changes only local focus. | One replacement landing; underlying history preserved; remount cannot reopen the predecessor. |
| `src/components/ProjectDashboard.mobileLaunchFocus.dom.test.tsx` | Rotate/open a provisional seat through both conversation and board paths, without invoking `draftSpawned`. Replace the placeholder with its same-ID transcript while the revoked predecessor publishes a more recent live write. Assert successor selection at every render. Main lacks registration and falls back to the predecessor. | Navigation, local pane, and durable conversation agree before/after adoption; scan lag and late seat reads cause no predecessor frame. Back leaves through the original underlying screen. |
| `src/lib/runtime/claudeMessageProvenance.test.ts` | Delivered SDK first entry has stamped `operator` origin, depth-zero receipt, matching seat launch and version 44. Assert `messages[uuid].mandate` is v44. Main omits the field. Exercise the actual producer result with the parser/lookup/renderer. | Correct card with full endpoint evidence. Cover custom/version qualifiers, reserved adoption identity, historical seat lookup, receipt-pruned identity where retained evidence permits, and an unrelated root launch with no mandate. |
| `src/components/feed/messageProvenance.parse.test.tsx` | Feed producer-generated `{messages: operator-by-UUID, occurrences: mandate}` through the existing lookup. The current mandate test at `:376` supplies only occurrences and misses the conflict. | Exact UUID answer carries the card semantics; a later identical-text operator delivery with its own UUID remains a user bubble, including a cropped tail. |
| `src/components/LogFeed.startingWindow.dom.test.tsx` | Retire launch facts before first tail, delay evidence until after an assistant reply, then close/reopen. Also cold-mount with no held/provenance cache and a catalog file lacking launch metadata. Existing tests from `:973` use ideal evidence. | v44 card plus handoff on live adoption, warm reopen, and cold/reload-equivalent mount; no incorrect row, duplicate card, or loss of an already displayed card. Known card waits through evidence delay; cold pending state never attributes the mandate to the operator. |

The component-level replay above demonstrates the selection failure and the real-record replay demonstrates the provenance failure on main. These regression cases have been specified; this read-only stage has not added tests or established a fixed branch's passing result.

## Rendered evidence: extend the existing driver

Add a `describe` case named “rotation retains the successor and mandate through adoption and reopen” to `src/components/mobile/issue1671Evidence.browser.test.tsx`, next to the existing handover case (`:7521`–`:7527`). Exercise desktop through the companion existing case in `src/components/kanban/kanbanBoard.browser.test.tsx:18341`–`:18347`. Extend the existing fixture and shared `captureSeatMandateHandover` helper (`src/components/kanban/issue1695BrowserHarness.ts:562`) with the rotation scenario. Create no driver or fixture named after this issue.

The current fixture hard-codes mandate metadata into both UUID and occurrence evidence (`src/components/mobile/issue1671Evidence.fixture.tsx:1339`–`:1341`) and returns a stable seat path with no launch ID (`:1564`). It cannot show either real failure. Generate the synthetic scenario's evidence through the production provenance/occurrence producers, served by the existing fixture server, so main retains the incomplete UUID answer and the fixed producer changes the actual result. Do not patch the fixture into correctness by manually assigning `.mandate`.

The case should:

1. Start with the predecessor selected and running. Rotate from its conversation menu; separately cover the board's seat control.
2. Accept the successor with a durable ID, launch ID, and null transcript path. Show its provisional v44 card and open the handoff disclosure.
3. Replace `spawn:` with the same conversation's transcript, delay tail and provenance independently, and let the revoked predecessor write its last turn. Re-publish stale incumbent status before a correct seat poll.
4. Assert the successor's visible conversation ID and selected/navigation key throughout. Observe mutations from first successful landing, including the adoption render. A poll must neither switch to the predecessor nor override a subsequent deliberate operator selection.
5. Leave and explicitly reopen the new seat, then reload and open it through the catalog. Assert one mandate card with v44 and handoff after evidence resolves, no mandate outside the card, and no operator bubble for the mandate. Preserve one legitimate later operator bubble to prevent an overbroad classifier fix.
6. Run phone 390 × 844 and desktop 1440 × 900 using the helper's en/uk and light/dark matrix. Claude reproduces this incident; retain the existing Codex handover coverage. Measure clipping/overflow and capture landing, adoption, reopen, and reload. The handoff content must remain reachable, and visible controls must retain usable geometry.

The helper already observes card lapses and leaked mandate text (`src/components/kanban/issue1695BrowserHarness.ts:589`–`:602`). Extend it to record conversation identity and navigation, distinguish intentional close/loading from a wrong frame, and distinguish a legitimate later operator message from a mandate bubble. Write sanitized JSON evidence alongside the existing driver's evidence records and capture screenshots in its established artifact output. Do not publish the supplied screenshots with their private labels.

Use `LLV_SWIPE_BROWSER_TEST=1` for the phone driver and `LLV_KANBAN_BROWSER_TEST=1` plus `CHROME_BIN` for the kanban driver. Filter to the named case and run each explicit file through `scripts/gate-slot.sh`. Render from an export of the reviewed implementation under the stage's existing scratch directory, with isolated state and an ephemeral port. Stop only processes started by that run, by their recorded PID.

## Validation performed and implementation gates

Prior-work lookup covered project-scoped and unscoped transcript searches for rotation/mandate, mandate bubbles/provenance, attention/focus, and phone jumps, plus memory searches for the same concepts. No prior answer explained these two failures. The auto-rotation design discussion, located by that project-scoped transcript search (final message 2026-10-08T23:03:55.255Z), preserves the existing explicit rotation path; it supplies no remedy for this incident. Existing draft-adoption tests and held-mandate tests were checked against current code and provide reusable mechanisms with the missing cases described above.

Read-only diagnosis completed both minimized reproductions. The following unchanged baseline tests passed, each by explicit path through `bash scripts/gate-slot.sh bun test`, with isolated `HOME`, `XDG_CONFIG_HOME`, `TMPDIR`, and `LLV_STATE_DIR`:

| Test file | Passed |
| --- | ---: |
| `src/lib/runtime/claudeMessageProvenance.test.ts` | 8 |
| `src/lib/runtime/deliveredMessageOccurrences.test.ts` | 17 |
| `src/components/feed/messageProvenance.parse.test.tsx` | 32 |
| `src/components/mobile/MobileFocusView.conversation.dom.test.tsx` | 17 |
| `src/components/ProjectDashboard.mobileLaunchFocus.dom.test.tsx` | 3 |
| `src/components/LogFeed.startingWindow.dom.test.tsx` | 32 |
| **Total** | **109** |

This pipeline checkout lacks `node_modules`. Component tests ran from an unmodified archive of the same commit in stage scratch, reusing an installed checkout's dependencies. Checked package versions fit the declarations; this is baseline diagnostic evidence, rather than exact-lockfile or full publication validation. No live-state suites, production API writes, source edits, staging, commits, pushes, or service restarts were performed. The architect stage has no fixed UI to capture and makes no rendered-fix claim.

The implementation stage must add the focused regressions and run each touched test file explicitly under fresh isolated roots. It must also run TypeScript (`bun x tsc --noEmit`), changed-file ESLint (`bun run lint -- <changed-source-files>`), `git diff --check`, and the repository's local privacy gate with the committed fingerprints. Put heavy commands behind `scripts/gate-slot.sh`; use the existing browser drivers for the rendered case. Required branch-green checks and public sanitized evidence are still acceptance gates for that implementation. The documentation-only stage's explicit-path privacy gate passed with `--require-known-values --check-commits --base origin/main`; whitespace checks also passed. It makes no TypeScript/lint claim for unedited product source.

## Requirement check

The proposed navigation change keeps the operator on the rotated successor while the predecessor finishes its revoked turn. The provenance change makes the same delivered mandate retain its card semantics through first-record adoption, manual reopening, catalog hydration, and reload on both surfaces. Focused tests expose the two omitted cases on main; existing drivers provide the phone and desktop record. The original report requires both fixes together: resolving either defect alone leaves the other observed failure intact.

## Deferred — not currently justified

- A new navigation service, continuous global follow-the-seat policy, or browser identity store. Existing navigation replacement and launch-adoption mapping suffice.
- Runtime cancellation of the predecessor, reordered pane scores, or automatic hiding as a focus fix. The predecessor's permitted final turn is part of the acceptance scenario.
- A new mandate text signature, persisted prompt cache, schema migration, transcript rewriting, or live record repair. Exact delivery identity already exists and can enrich the established provenance response.
- A generic change giving digest evidence precedence over UUID evidence. It would risk reclassifying genuine operator pastes.
- A separate browser driver, issue-specific capture script, UI variants, or a redesigned mandate card. Extend the established driver and retain the established card.
- Changes to the parallel needs-you and role-memory lanes beyond any narrowly necessary shared call sites. This diagnosis identifies no dependency on their features.
- An ADR. The proposed changes reuse existing reversible mechanisms and introduce no hard-to-reverse architectural decision.
