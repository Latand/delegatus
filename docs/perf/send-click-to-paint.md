# Send click-to-paint audit — 2026-10-15

Implementation continuation: the scheduling change specified below is now
applied to both composer preparation sites. The hop table and its measurement
limits are carried into
[the send-latency design](../design/send-latency-and-message-states.md#isolated-click-to-paint-hops--2026-10-15).
The audit narrative and sample rows below preserve the original research
stage's scope; its “scratch only” and “builder still owns” statements describe
that stage. The recorded before/after timings come from that experiment.

Builder verification on 2026-10-15: all four held-prerequisite controls failed
on the original composer because the manager read had not started. With the
overlap, **68 tests passed** across these explicit paths, run separately through
the assigned gate with isolated HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR
and a closed-loopback LLV_VIEWER_CONTROL_URL:

| Test file | Passed |
|---|---:|
| `src/components/TmuxComposer.viewerPrelude.dom.test.tsx` | 12 |
| `src/components/TmuxComposer.queueFirst.dom.test.tsx` | 2 |
| `src/components/TmuxComposer.admissionRecovery.dom.test.tsx` | 15 |
| `src/components/composerAdmissionDeadline.test.ts` | 2 |
| `src/hooks/useBridgeReportRelay.dom.test.tsx` | 37 |

The new cases exercise both prerequisite completion orders, pending bridge
acknowledgements, ordered sends, retained image bytes, manager timeout, pending
seat identity and a sealed-envelope retry with the original key. The existing
recovery cases cover lost answers, remounts and racing retries without another
send. The bridge suite emitted React act warnings and passed. The local
privacy gate with committed fingerprints passed; no production send was made.

The largest removable serial dependency demonstrated here is **Codex's bridge drain → manager-identity lookup before POST**. With each prerequisite held for 500 ms, overlapping them reduced median click → request from **1,014.7 to 517.0 ms**, and click → canonical-feed frame from **1,131.9 to 653.0 ms**. The change was tested only in a scratch export. The production long tail remains unattributed to this dependency; existing production records begin after it.

This audit contains **160 measured native sends**: 20 per engine, per prerequisite condition, before and after the experimental change. The installed Codex and Claude executables wrote their own transcripts. Credential-free loopback providers supplied their responses. No production send, external model request, restart, deploy, repository source edit, staging or commit was performed. The only worktree output is this report. The builder still owns implementation and publication.

**Measurement boundary.** “Canonical-feed frame” is the next animation-frame callback after the matching canonical user row is present and its local-outbox attributes have retired, following receipt of the actual transcript bytes. It is a render-opportunity proxy, with approximately one frame of scheduling exposure. It does not timestamp the display compositor. Screenshots taken after the checkpoint confirm visible rendered messages for both engines. Optimistic placement is measured separately. These results do not measure provider inference, a complete production dashboard, phone performance, or a hardware display's first visible pixel.

**Provenance and prior work.** Source was exported from `45d25ac796d5824713c9fb57d65f57efea61041b`. The latest successful deployment observed through `deployment_status({compact:true,limit:3})` was `781ecd4c33482d7486683d19d61a8b0bc8c14d38`, completed at 2026-10-15 00:28:32.843 UTC. `git diff 781ecd4c33482d7486683d19d61a8b0bc8c14d38 HEAD -- src/components/TmuxComposer.tsx src/components/voice/managerIdentity.ts src/hooks/useBridgeReportRelay.ts scripts/delivery-phase-report.ts src/lib/runtime/deliveryProgress.ts` was empty. The 24-hour production window spans multiple deployments.

`get_pipeline({pipelineId:"c527cb1d",full:true})` and `get_pipeline({pipelineId:"e15e445d",full:true})` were read, including the retained build/review/fix conclusions. The former measured 414 reservations and 36 Claude browser sends in 2026-10-09 22:37:26.862 through 2026-10-10 22:37:26.862 UTC; it explicitly lacked click/paint and historical reason transitions. Its final reviewer messages were opened with `conversation_messages` at the returned transcript path, since `2026-10-10T22:49:00Z`. The latter delivered phase history, ingress and raw echo instrumentation, including the fixes for retained open and cold uncertain records. Main's first-parent history contains `b73aa7958`, “Preserve delivery phase history and arrival timestamps (#2730)”. Its `scripts/delivery-phase-report.ts` was reused unchanged.

Read `docs/design/send-latency-and-message-states.md` through its implementation continuation. Its old global snapshot and output-consumer fixes are already implemented: `src/runtime-host/host.ts:178` allows durable engine publications to acknowledge without waiting for the shared consumer. They are not proposed again. Searches used `send latency paint` and `send phase timings` with the canonical project, then `click-to-paint` and `drainBridgeTurnStart prelude latency` unscoped. Memory searches used `send latency`, `delivery phase history`, and `composer prelude`. The relevant memory hit was opened by id and checked against current code: the previous manager-seat fix bounded its wait at 15 seconds; it did not overlap that read with the bridge. No prior complete click → native transcript → feed timing result was found. These reads occurred during 05:16–05:20 UTC.

**Production observation, read-only.** At 05:18:15.149 UTC, one SQLite backup was taken with a source connection opened using `mode=ro`, `PRAGMA query_only=ON`, and `PRAGMA busy_timeout=0`. The source was `$HOME/.config/delegatus/state/delivery-progress.sqlite`; the destination was in stage scratch. Snapshot SHA-256: `1ac06666c0e3ec4ad0113d4d2f203dd4d0c6c74f5324e35ea9ca260967eaf52b`. No application store constructor, migration or live HTTP probe was used. The seat GET was deliberately not probed in production: `src/app/api/orchestrator/seat/route.ts:162` can call launch reconciliation.

The exact existing report invocation, executed from the scratch source export at approximately 05:18 UTC, was:

```sh
rtk proxy env LLV_STATE_DIR="$HOME/.config/delegatus/state"   LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1   bun scripts/delivery-phase-report.ts   --since 2026-10-14T05:15:00Z --until 2026-10-15T05:15:00Z
```

It returned `records=983 missing_history=0 truncated_history=0 open_spans=0`. The script's query is `SELECT record_json FROM delivery_progress`; it filters on ingress/admission and excludes negative or out-of-window intervals. At 05:18:41–05:19:04 UTC, engine attribution used a separate read-only connection to `agent-registry.sqlite` and `SELECT row_key,value_json FROM registry_rows WHERE collection='conversations'`, joined by the progress record's conversation id. Initial schema inspection established that this table is in `agent-registry.sqlite`; it is absent from `state.sqlite`. No identifiers, account data or message bodies are reproduced here.

There were 500 Claude and 483 Codex records. Only 92 Claude and 22 Codex records carry HTTP-ingress timestamps. These are the instrumented HTTP subset; browser origin was not independently joined to the request ledger in this audit. All percentiles below use linear interpolation at `(n-1)*p`, matching the retained report script. The older lane used nearest rank, so its p95 values are not directly comparable. Phase percentiles must not be added.

| Production interval | Claude n; p50 / p95 ms | Codex n; p50 / p95 ms |
|---|---:|---:|
| HTTP handler ingress → admission | 92; 225.5 / 19,703.2 | 22; 236.0 / 2,803.0 |
| Admission → raw engine echo | 499; 4,416.0 / 45,830.1 | 483; 1,584.0 / 18,254.4 |
| HTTP handler ingress → raw engine echo | 92; 5,999.5 / 70,677.8 | 22; 8,378.0 / 34,678.2 |
| Raw engine echo → delivery confirmation | 486; 492.0 / 3,661.0 | 483; 676.0 / 5,319.2 |

Thirteen Claude confirmations precede their recorded raw echo and are excluded from the last row; one Claude record lacks an echo. They are not treated as zero-delay samples. Native transcript arrival and the host's raw echo are distinct boundaries. In the isolated data, Claude's transcript timestamp commonly precedes its raw echo.

The reused phase report returned these largest relevant span classes. Counts are spans, and one send can contribute several:

| Recorded phase / reason | Spans | p50 ms | p95 ms | Interpretation |
|---|---:|---:|---:|---|
| awaiting-turn | 108 | 22,503.5 | 108,331.5 | Turn-boundary behavior; no authority to bypass it |
| evidence-unreadable / runtime host unavailable | 4 | 74,924.5 | 118,120.9 | Outage/recovery exposure |
| wake-lost / no delivery pass reached it when due | 64 | 5,251.5 | 74,326.5 | Missed delivery-pass observation; no lock/GC attribution |
| update-drain | 2 | 59,011.0 | 59,018.2 | Release-drain behavior |
| queued | 1,013 | 682.0 | 14,250.6 | Aggregate queue dwell |
| checking / admitting to runtime journal | 983 | 78.0 | 807.3 | Recorded admission step |

A second filter over the same backup, 2026-10-15 00:29:00–05:15:00 UTC, contains 72 records (22 Claude, 50 Codex), but only two ingress-marked Claude sends and no ingress-marked Codex sends. It cannot supply a meaningful current-release browser percentile. The 24-hour server tail is real, but neither these spans nor the isolated overlap experiment proves its dominant removable cause. State locks, GC, snapshots and missed wakes remain with their existing lanes.

**Isolated native path and clocks.** Reused the existing `src/components/conversation/conversationWindow.browser.test.tsx` driver and `scripts/capture-composer-payloads.fixture.tsx`, with a scratch-only case. Reused `src/lib/runtime/fixtures/nativeCodexRuntime.ts` for the real runtime handlers, Unix-socket runtime journal, reservation/queue/controller and Codex app-server. The same helper was adapted in scratch for `ClaudeStreamBrokerHost` using the existing loopback Messages provider setup in `src/lib/runtime/claudeStreamBrokerHost.nativeQueue.test.ts`.

The browser served the real `NativeConversationPane`, composer, outbox, `LogFeed`, `useLogTail` and `logBus`. A port-0 server called the real send handler. `createLogTailEventStream` watched only the isolated native transcript and delivered its real bytes. The provenance adapter joined actual receipts to the native Claude delivery ledger or Codex operation-dedup tokens. Model-provider replies, account/model catalog responses, bootstrap session metadata, manager-identity/bridge answers and receipt polling were fixture adapters. The full Next.js middleware, production board workload and runtime-event SSE were outside this measurement; the measured paint route was canonical transcript SSE. No new driver file was created.

Bun was 1.4.0; installed native binaries were Codex 0.162.1 and Claude Code 2.1.296. Chromium came from the installed `chromium-1248` browser cache. Viewport: 1280×900, dark theme, English, visible active feed. There was one warm-up turn per native run, excluded from the samples. Every sample used a fresh browser context against the same warm native conversation. The identity cache was explicitly reset immediately before submit; each send waited for the preceding turn to become idle. Condition 0 uses immediate prerequisite replies; condition 500 delays each applicable prerequisite reply by 500 ms. Claude has no bridge drain in this fixture.

Browser marks use `performance.timeOrigin + performance.now()`. Server ingress and emitted-chunk marks use the same epoch conversion in the driver process. Native records and production phase observations have millisecond UTC timestamps. The sample text and original idempotency key join click, request, operation, native record and row; the appendix replaces identities with ordinals. Each sample was required to match exactly one canonical native user record (`response_item` user message for Codex; `user` envelope for Claude), and all recorded keys are distinct and native timestamps ordered within each run. This establishes sampled delivery multiplicity and order; it is not exhaustive crash/retry coverage.

The initial browser launch failed because Chromium's singleton socket path was too long. Only its TMPDIR was shortened to an owned home-cache directory. The first native Codex pilot selected the wrong native record type; a second pilot stopped after 13 valid samples because canonical rows can use a generic user renderer after the retained receipt window changes. Inspection of its screenshot and DOM proved the message was visible. The observer was widened to both canonical renderers, and the complete 40-sample run was restarted. Pilot observations are excluded below. A first DOM control also hit a mount-warmed identity cache; its corrected version resets the cache at submit and reproduces the serial dependency.

All heavy runs went through the assigned `gate-slot.sh`, one at a time. HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME, TMPDIR and LLV_STATE_DIR were isolated, with `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`. Native binaries received private provider homes and credential-free loopback endpoints. Dependencies were borrowed read-only only after matching the manifest, lockfile and patches byte for byte. An observed native run's tightest cgroup limits were three CPUs (`60000 20000`) and 8 GiB; it had CPU throttling and zero own-cgroup OOM kills. These are loaded-machine observations, not unthrottled host capacity measurements. All child PIDs were recorded by the native fixture and stopped through their owned host/browser handles; the gate reported no leaked descendants.

**Native hop table.** Baseline source, immediate prerequisite replies, n=20 for each cell. Values are p50 / p95 milliseconds. “Queued” and “dispatching” are phase-history timestamps; no finer commit-time claim is made. Raw echo is shown separately from the native record because those paths can progress independently.

| Hop | Codex | Claude |
|---|---:|---:|
| Click → optimistic-row frame | 29.0 / 32.4 | 28.9 / 33.4 |
| Click → POST fetch invocation | 17.8 / 21.2 | 15.8 / 29.6 |
| POST invocation → isolated handler ingress | 1.3 / 1.7 | 1.3 / 2.1 |
| Handler ingress → queued phase | 9.7 / 13.1 | 8.0 / 12.6 |
| Queued → first dispatching phase | 4.0 / 6.1 | 3.0 / 5.0 |
| First dispatching phase → native record timestamp | 26.5 / 38.2 | 6.0 / 8.1 |
| Click → native record timestamp | 61.1 / 73.6 | 34.9 / 50.2 |
| Click → raw engine echo | 62.1 / 74.6 | 47.9 / 66.2 |
| Native record timestamp → server emits transcript chunk | 3.4 / 8.7 | 21.8 / 30.1 |
| Server chunk → browser log-bus delivery | 0.3 / 0.9 | 0.4 / 0.8 |
| Browser chunk → canonical-row frame | 23.7 / 32.2 | 33.5 / 39.5 |
| Click → canonical-row frame | 92.1 / 111.1 | 93.4 / 123.4 |

The first user row is already present before native confirmation. Canonical adoption normally preserves it. The final interval above measures when the feed has consumed native evidence and presents the canonical row; it does not suggest that the operator sees no message until then. Source boundaries: `src/components/conversation/OutboxDispatcher.tsx:38`, `src/lib/runtime/http.ts:480`, `src/lib/runtime/codexAppServerHost.ts:3911`, `src/lib/runtime/claudeStreamBrokerHost.ts:1461`, `src/lib/runtime/structuredDeliveryController.ts:1705`, `src/lib/logTailStream.ts:254`, and `src/hooks/logBus.ts:153`.

**Before/after and causal evidence.** Every row below contains 20 fresh-context sends. The “after” source differs only by beginning the bounded manager lookup before awaiting the bridge drain, at both composer preparation sites. Fixture instrumentation is identical between the compared runs.

| Engine | Prerequisite delay | Source | Click → request p50 / p95 ms | Click → canonical frame p50 / p95 ms |
|---|---:|---|---:|---:|
| Codex | 0 ms | before | 17.8 / 21.2 | 92.1 / 111.1 |
| Codex | 500 ms | before | 1,014.7 / 1,019.7 | 1,131.9 / 1,146.3 |
| Claude | 0 ms | before | 15.8 / 29.6 | 93.4 / 123.4 |
| Claude | 500 ms | before | 515.0 / 527.0 | 616.5 / 644.9 |
| Codex | 0 ms | after | 20.8 / 35.7 | 110.9 / 159.8 |
| Codex | 500 ms | after | 517.0 / 530.9 | 653.0 / 710.9 |
| Claude | 0 ms | after | 21.0 / 32.3 | 125.5 / 181.1 |
| Claude | 500 ms | after | 515.6 / 518.9 | 642.2 / 675.1 |

For all 20 delayed Codex sends before the change, the manager request started after the bridge finished (median gap 0.3 ms). After the change, all 20 manager requests started while the bridge remained pending (median 505.5 ms before its completion). The click → request saving is **497.7 ms**; the canonical-frame saving is **478.9 ms**, with p95 falling from **1,146.3 to 710.9 ms**. The independent UI-only fixture run also produced 1,011.8 → 511.0 ms median click → request. Claude's delayed click → request was 515.0 → 515.6 ms, the expected negative control because it performs one prerequisite read.

The immediate-response native samples became slower in the later run: Codex canonical-frame median 92.1 → 110.9 ms; Claude 93.4 → 125.5 ms. The runs differ in execution time and retained transcript size under a shared CPU quota; the cause of this smaller variation was not isolated. The controlled dependency gain is substantially larger, and its request-start ordering provides causal evidence independent of those medians. No ordinary-send or production-wide speedup is claimed.

The blocking edges are explicit in current source:

- `src/components/TmuxComposer.tsx:3896` awaits `drainBridgeTurnStart()` before `:3912` invokes the bounded manager lookup for plain sends. The attachment/durable-preparation path repeats the order at `:3602` and `:3603`.
- `src/components/voice/managerIdentity.ts:56` issues the seat GET on a cold/expired cache; `:26` sets a 30-second TTL. `src/components/composerAdmissionDeadline.ts:1` gives that optional lookup a 15-second deadline.
- `src/hooks/useBridgeReportRelay.ts:365` deliberately retires earlier acknowledgements before its GET at `:373`. That internal ordering must remain intact. Each bridge request has an 8-second timeout (`:113`, `:233`); pending acknowledgement retirement can involve additional work, so eight seconds is not a bound on the entire drain.

The manager identity query takes only conversation/project identity and never uses the bridge result. Both results are consumed later when constructing one payload. Thus the outer bridge → manager dependency can be removed while preserving the bridge's own acknowledgement order and the single-send fence. The maximum saving from this overlap is approximately the smaller of the two waits. A warm identity cache yields little or no benefit. This is the largest avoidable wait *demonstrated in these controlled isolated traces*; the records cannot rank it against unobserved production pre-handler waits.

**Fix design for the builder.** At both cited composer sites, start the existing bounded manager lookup, attach its existing failure handler immediately, then await the bridge drain and the identity result before assembling the payload. For durable/replayed generations, keep both operations skipped and reuse the retained envelope. Preserve `withComposerSubmission`, retain → seal → beginAttempt ordering, original key, outbox order, selected-context capture, payload formatting and bridge acknowledgement ownership. Do not change queue/interrupt policy, native dispatch concurrency, timeouts, registry settlement or runtime-event publication.

The essential scheduling change is:

```ts
const managerRead = withComposerAdmissionDeadline(
  isDesignatedManagerConversation(cardId, project),
  admissionTiming.admissionDeadlineMs,
).catch(() => false);
const bridge = await drainBridgeTurnStart();
const isManager = await managerRead;
// Build and seal the same payload, then dispatch under its original key.
```

Use each call site's existing replay guards and captured project value. This starts an existing optional read earlier; it does not authorize dispatch before required payload preparation. A seat GET can reconcile a pending launch, so keep authorization and identity checks server-side and verify pending-seat/rotation cases. No bridge acknowledgement may be committed merely because the identity request finished. The positive-context regression below verifies that both preludes still enter one message. Extend it for a durable attachment, pending bridge acknowledgement, lookup timeout and replay before publishing the implementation.

**Reproducing the native experiment (fix continuation, 2026-10-15).** The
`native send paint audit` case is now saved in the existing
`src/components/conversation/conversationWindow.browser.test.tsx` driver. Its
composer fixture selects production log tailing with `native-paint=1`; the
existing native runtime fixture accepts Claude as well as Codex. The case
requires installed native binaries and Chromium, and fails if either engine is
missing. No account credentials or external model service are needed.

From a source checkout or clean export with matching dependencies, set
`CHROME_BIN`, `LLV_CODEX_BINARY` and `LLV_CLAUDE_BINARY` to absolute executable
paths. Set `GATE` to the assigned gate when running in a pipeline; otherwise it
defaults to the repository gate. Run this single command sequence:

```sh
: "${CHROME_BIN:?Set the installed Chromium executable}"
: "${LLV_CODEX_BINARY:?Set the installed Codex executable}"
: "${LLV_CLAUDE_BINARY:?Set the installed Claude executable}"
PAINT_RUN="$(mktemp -d /var/tmp/send-paint-run.XXXXXX)"
PAINT_OUT="$PWD/.artifacts/send-paint/$(basename "$PAINT_RUN")"
mkdir -p "$PAINT_RUN/home" "$PAINT_RUN/config" "$PAINT_RUN/cache" \
  "$PAINT_RUN/tmp" "$PAINT_RUN/state"
rtk proxy env HOME="$PAINT_RUN/home" XDG_CONFIG_HOME="$PAINT_RUN/config" \
  XDG_CACHE_HOME="$PAINT_RUN/cache" TMPDIR="$PAINT_RUN/tmp" \
  LLV_STATE_DIR="$PAINT_RUN/state" LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1 \
  LLV_NATIVE_SEND_PAINT_TEST=1 CHROME_BIN="$CHROME_BIN" \
  LLV_CODEX_BINARY="$LLV_CODEX_BINARY" LLV_CLAUDE_BINARY="$LLV_CLAUDE_BINARY" \
  SEND_PAINT_OUT="$PAINT_OUT" bash "${GATE:-scripts/gate-slot.sh}" \
  bun test src/components/conversation/conversationWindow.browser.test.tsx \
  -t 'native send paint audit'
```

One invocation runs 160 measured sends: 20 per engine, delay (0/500 ms), and
source condition. Each engine gets a warm-up turn, excluded from the samples.
Every send uses a fresh browser context and a cold manager cache, waits for
native idle and for the feed to contain the preceding native user record
before arming the clock, and traverses the real send handler, runtime journal, engine
process, native transcript and transcript SSE. The browser mark comes from a
subscriber to the production log bus. Both canonical row renderers are checked;
exactly one matching row must be visible with no local-outbox attributes.
The saved checkpoint also waits for the feed's automatic scroll to bring that
row inside its clipped viewport. That can add a frame after DOM adoption; the
historical scratch checkpoint only required DOM adoption. Compare the saved
before/after groups with each other, keeping the older rows as their own run.

The `before` bundle restores the old bridge-before-manager order at both
composer preparation sites through the existing fixture bundler. Its source
matcher refuses a changed or already-serial source shape. The `after` bundle
uses the current composer unchanged. The driver checks request ordering and
both preparation barriers for every sample; timing medians remain observations
under the machine's current load. Neither production source nor the checkout
is rewritten to run the control. The other fixture users keep synthetic log
input unless they explicitly select native paint mode.

Outputs under `PAINT_OUT` are `samples.json`, `samples.csv` (the original hop
columns, milliseconds relative to click), `summary.json` (eight groups of 20,
linearly interpolated p50/p95), `frames.json` (visibility and geometry), and
eight PNG frames. Samples are written incrementally, so a failed run retains
its partial data and a failure frame; only a complete run replaces the
incomplete summary marker with eight groups covering 160 rows. Fresh evidence goes to a new output directory when retaining multiple
runs. Engine processes and loopback servers are closed through their owned
handles; the case removes only its own temporary runtime/browser directory.
The command's private environment directory remains available for inspection.

The committed case was replayed from a clean export on 2026-10-15 with the
same installed versions listed above: **160 sends, eight groups of 20, 5,351
assertions, zero failures**, in 189.5 seconds of runner time. All eight frames
show one visible canonical message and zero horizontal overflow; the frames
were also inspected visually. The replay's medians are:

| Engine | Delay | Source | Click → request ms | Click → visible canonical frame ms |
|---|---:|---|---:|---:|
| codex | 0 ms | before | 35.5 | 253.4 |
| codex | 0 ms | after | 30.9 | 368.5 |
| codex | 500 ms | before | 1026.8 | 1213.9 |
| codex | 500 ms | after | 519.7 | 804.4 |
| claude | 0 ms | before | 24.9 | 274.1 |
| claude | 0 ms | after | 28.4 | 310.2 |
| claude | 500 ms | before | 521.2 | 654.3 |
| claude | 500 ms | after | 515.6 | 680.6 |

The delayed Codex request saving is 507.2 ms; the visible-frame saving is
409.5 ms. Immediate-reply frame medians increased in the later groups. These
loaded-machine observations establish the controlled prerequisite overlap;
they leave the production long-tail cause unresolved.

The historical audit used scratch adaptations of these same fixtures and an
older `AUDIT_ENGINE`/`AUDIT_BINARY` invocation, one engine and source condition
at a time. Its four completed runs and original sample rows below are retained
as dated observations. The saved case above is the reproducible entry point.

Complete native runs each passed 161 assertions and one browser test (25 unrelated cases filtered out). Their click-time UTC bounds and raw sample hashes are:

| Run | First click UTC | Last click UTC | SHA-256 of raw samples.json |
|---|---|---|---|
| before codex | 2026-10-15T05:28:53.962Z | 2026-10-15T05:29:54.174Z | `d900552bc62a1e46ac3c64fb77d848c9766e4e64012671937da4e4167d73ae0e` |
| before claude | 2026-10-15T05:30:16.492Z | 2026-10-15T05:31:07.124Z | `38995ddad9a1cbbd5aebc6da42bba8a303bf0f274dc7065faacc99c79e21394c` |
| after codex | 2026-10-15T05:31:44.975Z | 2026-10-15T05:32:40.836Z | `bd3493e4f33316588359a43db60c2153d5632dac1c98e1068fca2c1ae37d87b2` |
| after claude | 2026-10-15T05:33:18.633Z | 2026-10-15T05:34:15.336Z | `99d811964cbc70f7fce9899f12469035c275c5590b69d6d484b73778520c0807` |

The corrected focused regression in the scratch copy of `src/components/TmuxComposer.viewerPrelude.dom.test.tsx` resets the identity cache at submit, holds the bridge response, and asserts that the identity GET has started while the send itself remains undispatched. The original composer fails with expected one seat read, received zero. With the overlap change it passes; releasing the bridge produces exactly one payload containing both bridge and manager preludes and the authored text.

```sh
# Original source, corrected causal control: exit 1, expected failure.
rtk proxy env HOME="$RUN/home" XDG_CONFIG_HOME="$RUN/config"   TMPDIR="$RUN/tmp" LLV_STATE_DIR="$RUN/state"   LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1   bash "$GATE" bun test src/components/TmuxComposer.viewerPrelude.dom.test.tsx   -t 'manager identity starts while'

# Experimental overlap source: 24 pass, zero failures, 364 assertions.
rtk proxy env HOME="$RUN/home" XDG_CONFIG_HOME="$RUN/config"   TMPDIR="$RUN/tmp" LLV_STATE_DIR="$RUN/state"   LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1   bash "$GATE" bun test   src/components/TmuxComposer.viewerPrelude.dom.test.tsx   src/components/TmuxComposer.queueFirst.dom.test.tsx   src/components/TmuxComposer.admissionRecovery.dom.test.tsx   src/components/composerAdmissionDeadline.test.ts
```

These checks ran after the native samples and completed before 05:43:25 UTC on 2026-10-15. They cover manager scoping/rotation, queue-first input, original-key recovery without a second send, late receipts and bounded admission. The new overlap regression and experimental source remain in scratch only. At 2026-10-15 05:45:51 UTC, the report passed the local privacy gate with committed known-value fingerprints and the explicit document path. Whitespace validation used `git diff --no-index --check /dev/null docs/perf/send-click-to-paint.md`. The privacy invocation was `bun scripts/privacy-publication-gate.ts --require-known-values --repository "$WORKTREE" --paths docs/perf/send-click-to-paint.md`, with `LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE` pointing to the exported committed file and the same isolated environment. No PR was created, so hosted CI was not triggered; the implementation stage still owes the project's required publication checks.

**Retained sample evidence.** The following CSV preserves every complete native trial without message bodies or identities. Durations are milliseconds from the browser click; raw native/echo timestamps have 1 ms resolution. `post`, `handler`, `native`, `echo`, `server_chunk`, `browser_chunk`, `canonical_frame`, and `optimistic_frame` identify the marks defined above. `queued` and `dispatching` use the first corresponding phase-history entry; bridge/seat columns preserve the causal request ordering. Empty bridge cells are the Claude skip path. The click UTC fixes each row's time bounds. These observations should be used with their fixture and render-opportunity limits.

```csv
source,engine,delay_ms,trial,click_utc,post_ms,handler_ms,queued_ms,dispatching_ms,native_ms,echo_ms,server_chunk_ms,browser_chunk_ms,canonical_frame_ms,optimistic_frame_ms,bridge_start_ms,bridge_end_ms,seat_start_ms,seat_end_ms
before,codex,0,0,2026-10-15T05:28:53.962Z,15.0,16.1,22.5,25.5,68.5,69.5,70.1,70.5,93.1,29.6,7.3,12.9,13.6,13.8
before,codex,0,1,2026-10-15T05:28:55.012Z,15.1,16.4,25.2,32.2,49.2,53.2,66.8,67.1,92.3,26.1,8.0,13.1,13.6,13.8
before,codex,0,2,2026-10-15T05:28:56.078Z,17.4,19.1,27.3,30.3,47.3,47.3,52.8,53.0,76.4,26.9,9.4,14.3,14.9,15.3
before,codex,0,3,2026-10-15T05:28:57.080Z,21.1,22.7,34.6,37.6,63.6,64.6,70.7,71.0,91.9,26.2,11.6,17.6,18.4,18.8
before,codex,0,4,2026-10-15T05:28:58.143Z,16.7,17.9,24.9,27.9,45.9,45.9,46.5,46.7,78.7,32.2,7.3,14.9,15.3,15.3
before,codex,0,5,2026-10-15T05:28:59.115Z,23.4,25.1,37.4,41.4,62.4,63.4,67.3,67.7,89.5,29.7,15.3,20.3,21.0,21.2
before,codex,0,6,2026-10-15T05:29:00.126Z,18.4,19.6,25.3,28.3,49.3,50.3,57.5,57.8,78.3,32.4,9.1,16.1,16.6,16.8
before,codex,0,7,2026-10-15T05:29:01.109Z,18.1,19.2,28.8,32.8,59.8,60.8,64.5,66.5,95.9,29.6,7.9,15.7,16.3,16.4
before,codex,0,8,2026-10-15T05:29:02.142Z,17.2,18.4,25.4,28.4,51.4,52.4,52.2,52.5,79.0,30.6,7.4,15.2,15.6,15.7
before,codex,0,9,2026-10-15T05:29:03.110Z,16.0,17.5,26.2,31.2,55.2,57.2,58.6,58.8,77.9,27.6,8.1,13.8,14.2,14.4
before,codex,0,10,2026-10-15T05:29:04.127Z,17.7,19.0,28.9,31.9,55.9,55.9,57.3,57.6,78.0,28.2,8.9,14.6,15.4,15.5
before,codex,0,11,2026-10-15T05:29:05.110Z,17.4,19.0,31.5,37.5,69.5,71.5,77.5,78.4,113.5,28.0,9.3,14.2,14.9,15.2
before,codex,0,12,2026-10-15T05:29:06.176Z,16.8,18.1,25.3,27.3,54.3,55.3,57.7,57.7,78.0,31.3,8.5,14.4,14.8,15.0
before,codex,0,13,2026-10-15T05:29:07.175Z,18.0,19.3,25.2,28.2,53.2,54.2,54.6,54.9,78.9,32.4,8.3,15.7,16.1,16.2
before,codex,0,14,2026-10-15T05:29:08.177Z,18.4,19.6,32.7,37.7,74.7,75.7,81.9,82.5,111.0,28.2,9.9,14.8,15.5,15.7
before,codex,0,15,2026-10-15T05:29:09.225Z,18.8,20.0,30.1,35.1,65.1,66.1,68.2,68.5,95.5,29.2,8.9,15.5,15.9,16.1
before,codex,0,16,2026-10-15T05:29:10.242Z,18.4,19.7,31.1,35.1,70.1,71.1,76.1,76.3,96.4,28.9,8.6,15.0,15.5,15.6
before,codex,0,17,2026-10-15T05:29:11.259Z,18.3,19.7,30.5,35.5,68.5,69.5,69.8,70.0,94.9,28.7,9.3,14.9,15.5,15.6
before,codex,0,18,2026-10-15T05:29:12.276Z,18.9,20.5,34.1,38.1,69.1,69.1,69.9,70.2,96.5,28.5,9.7,15.0,15.6,15.8
before,codex,0,19,2026-10-15T05:29:13.325Z,17.4,18.7,29.5,35.5,73.5,74.5,74.6,75.4,96.3,29.7,8.1,15.1,15.4,15.5
before,codex,500,0,2026-10-15T05:29:14.325Z,1009.9,1011.1,1019.7,1021.7,1055.7,1057.7,1062.5,1063.3,1096.0,29.7,8.8,508.9,509.2,1009.3
before,codex,500,1,2026-10-15T05:29:16.345Z,1017.8,1019.4,1029.3,1032.3,1067.3,1068.3,1073.0,1073.3,1093.2,27.1,16.5,516.6,516.9,1017.0
before,codex,500,2,2026-10-15T05:29:18.359Z,1010.0,1011.2,1019.6,1021.6,1056.6,1057.6,1065.1,1065.4,1095.0,28.6,8.9,509.0,509.3,1009.5
before,codex,500,3,2026-10-15T05:29:20.360Z,1013.7,1015.5,1022.5,1025.5,1069.5,1070.5,1071.8,1072.1,1096.1,27.2,12.3,512.4,512.8,1012.9
before,codex,500,4,2026-10-15T05:29:22.466Z,1013.6,1015.5,1029.8,1033.8,1103.8,1104.8,1110.0,1111.1,1139.8,21.6,11.7,511.9,512.4,1012.4
before,codex,500,5,2026-10-15T05:29:24.611Z,1020.4,1022.3,1037.6,1041.6,1095.6,1098.6,1110.8,1111.4,1142.7,29.1,18.8,519.0,519.4,1019.5
before,codex,500,6,2026-10-15T05:29:26.658Z,1011.9,1014.1,1023.4,1026.4,1075.4,1076.4,1076.4,1079.4,1119.5,28.9,10.5,510.6,510.9,1011.0
before,codex,500,7,2026-10-15T05:29:28.711Z,1014.6,1016.3,1026.6,1031.6,1084.6,1085.6,1089.6,1092.3,1126.0,26.2,12.8,513.0,513.6,1013.7
before,codex,500,8,2026-10-15T05:29:30.776Z,1013.7,1015.4,1028.1,1035.1,1109.1,1112.1,1115.6,1116.0,1145.5,27.1,12.4,512.5,512.8,1013.0
before,codex,500,9,2026-10-15T05:29:32.936Z,1013.8,1015.7,1030.4,1034.4,1091.4,1094.4,1103.3,1103.7,1134.0,17.4,12.5,512.5,512.9,1012.9
before,codex,500,10,2026-10-15T05:29:35.045Z,1019.7,1021.3,1036.0,1042.0,1098.0,1099.0,1099.6,1099.8,1129.7,27.9,18.4,518.6,518.9,1018.9
before,codex,500,11,2026-10-15T05:29:37.131Z,1016.3,1018.3,1029.8,1033.8,1100.8,1101.8,1106.3,1107.5,1139.3,23.1,14.7,514.8,515.1,1015.3
before,codex,500,12,2026-10-15T05:29:39.294Z,1012.2,1013.6,1025.7,1030.7,1088.7,1090.7,1098.9,1099.3,1126.2,26.3,11.0,511.1,511.5,1011.6
before,codex,500,13,2026-10-15T05:29:41.427Z,1016.3,1018.1,1032.2,1037.2,1099.2,1102.2,1104.3,1104.8,1129.1,25.7,14.9,515.1,515.3,1015.4
before,codex,500,14,2026-10-15T05:29:43.562Z,1015.6,1017.5,1031.5,1035.5,1107.5,1110.5,1124.3,1125.7,1160.8,28.2,13.9,514.1,514.5,1014.6
before,codex,500,15,2026-10-15T05:29:45.726Z,1015.1,1016.7,1031.4,1035.4,1103.4,1104.4,1113.2,1113.6,1144.0,26.9,13.6,513.8,514.1,1014.2
before,codex,500,16,2026-10-15T05:29:47.878Z,1018.3,1019.5,1036.9,1041.9,1104.9,1105.9,1108.2,1109.9,1143.5,25.6,15.1,515.2,515.5,1017.8
before,codex,500,17,2026-10-15T05:29:49.994Z,1016.0,1017.3,1030.9,1034.9,1105.9,1107.9,1116.8,1117.1,1143.4,25.7,14.8,515.0,515.4,1015.4
before,codex,500,18,2026-10-15T05:29:52.082Z,1014.8,1016.1,1032.0,1036.0,1105.0,1106.0,1105.6,1107.2,1138.5,23.3,13.5,513.7,514.1,1014.2
before,codex,500,19,2026-10-15T05:29:54.174Z,1012.0,1013.7,1027.7,1030.7,1091.7,1093.7,1099.7,1099.9,1128.6,28.6,10.7,510.8,511.1,1011.2
before,claude,0,0,2026-10-15T05:30:16.492Z,13.2,14.6,22.0,26.0,32.0,45.0,53.8,54.1,92.2,28.4,,,7.9,12.2
before,claude,0,1,2026-10-15T05:30:17.525Z,17.5,19.1,25.6,29.6,35.6,47.6,57.3,57.6,93.1,26.8,,,11.9,16.5
before,claude,0,2,2026-10-15T05:30:18.523Z,14.6,15.9,23.2,25.2,32.2,48.2,59.6,60.0,94.6,29.1,,,7.1,13.7
before,claude,0,3,2026-10-15T05:30:19.506Z,15.3,16.6,23.0,25.0,30.0,40.0,48.2,48.6,78.2,28.7,,,8.2,14.8
before,claude,0,4,2026-10-15T05:30:20.475Z,17.8,19.1,26.1,29.1,34.1,43.1,51.2,51.5,75.9,26.3,,,14.0,17.0
before,claude,0,5,2026-10-15T05:30:21.441Z,16.5,17.7,25.1,29.1,34.1,43.1,51.1,51.3,77.4,31.1,,,12.3,15.5
before,claude,0,6,2026-10-15T05:30:22.407Z,15.1,16.8,25.4,27.4,34.4,46.4,58.0,58.4,94.2,33.2,,,8.7,13.7
before,claude,0,7,2026-10-15T05:30:23.441Z,13.1,15.2,27.1,32.1,37.1,52.1,66.4,66.8,93.1,27.0,,,8.7,12.2
before,claude,0,8,2026-10-15T05:30:24.456Z,18.1,19.8,32.3,36.3,40.3,53.3,63.7,64.1,95.2,29.3,,,7.8,16.7
before,claude,0,9,2026-10-15T05:30:25.472Z,15.8,17.0,26.3,28.3,35.3,48.3,57.1,57.4,95.5,34.6,,,7.9,15.2
before,claude,0,10,2026-10-15T05:30:26.512Z,31.1,33.6,48.5,53.5,62.5,77.5,87.8,88.3,122.6,28.4,,,19.7,29.4
before,claude,0,11,2026-10-15T05:30:27.556Z,15.9,17.2,25.9,27.9,32.9,43.9,54.7,55.1,78.8,32.7,,,8.1,15.3
before,claude,0,12,2026-10-15T05:30:28.557Z,14.7,16.0,23.4,27.4,33.4,45.4,54.3,54.6,93.8,31.7,,,8.5,13.8
before,claude,0,13,2026-10-15T05:30:29.539Z,15.7,17.0,23.5,25.5,31.5,46.5,54.7,55.0,78.5,30.6,,,8.3,14.9
before,claude,0,14,2026-10-15T05:30:30.523Z,15.3,16.7,25.6,28.6,35.6,53.6,65.2,65.5,94.9,33.3,,,8.6,14.4
before,claude,0,15,2026-10-15T05:30:31.524Z,22.3,23.4,30.7,33.7,37.7,48.7,58.3,58.7,93.8,27.6,,,14.9,20.5
before,claude,0,16,2026-10-15T05:30:32.523Z,15.8,16.9,23.8,25.8,31.8,41.8,50.0,50.2,78.2,31.0,,,8.8,14.8
before,claude,0,17,2026-10-15T05:30:33.491Z,21.5,22.6,35.0,37.0,41.0,52.0,59.7,60.1,92.8,27.5,,,15.9,20.6
before,claude,0,18,2026-10-15T05:30:34.511Z,29.5,31.4,40.6,43.6,49.6,65.6,78.1,78.5,123.3,27.2,,,19.8,27.9
before,claude,0,19,2026-10-15T05:30:35.575Z,16.8,18.2,30.4,35.4,43.4,65.4,82.8,89.2,125.6,26.2,,,11.4,15.7
before,claude,500,0,2026-10-15T05:30:36.659Z,515.6,517.4,527.8,529.8,533.8,545.8,554.4,554.7,592.2,25.4,,,14.6,514.7
before,claude,500,1,2026-10-15T05:30:38.224Z,514.3,516.1,524.6,527.6,536.6,563.6,576.1,576.4,609.9,26.9,,,13.2,513.4
before,claude,500,2,2026-10-15T05:30:39.758Z,512.0,514.2,532.9,537.9,546.9,569.9,589.5,589.9,643.1,26.7,,,9.0,509.2
before,claude,500,3,2026-10-15T05:30:41.360Z,510.4,511.9,524.7,529.7,533.7,547.7,558.7,559.8,591.3,24.3,,,9.7,509.8
before,claude,500,4,2026-10-15T05:30:42.958Z,515.0,516.9,530.3,533.3,539.3,556.3,570.2,575.4,609.4,26.6,,,13.9,514.1
before,claude,500,5,2026-10-15T05:30:44.591Z,514.6,516.5,530.4,533.4,540.4,566.4,585.9,586.3,627.2,26.3,,,13.4,513.5
before,claude,500,6,2026-10-15T05:30:46.208Z,514.2,516.4,528.7,532.7,539.7,562.7,574.9,575.4,609.8,26.3,,,13.0,513.2
before,claude,500,7,2026-10-15T05:30:47.790Z,511.5,512.8,525.7,529.7,537.7,557.7,573.0,573.4,610.4,28.0,,,10.4,510.8
before,claude,500,8,2026-10-15T05:30:49.357Z,518.1,520.2,537.8,541.8,550.8,568.8,582.7,583.3,610.3,27.4,,,16.9,517.2
before,claude,500,9,2026-10-15T05:30:50.943Z,519.4,521.3,537.6,542.6,551.6,576.6,589.3,589.9,640.8,24.0,,,18.3,518.4
before,claude,500,10,2026-10-15T05:30:52.577Z,526.9,528.6,542.4,545.4,550.4,570.4,586.1,592.7,639.6,35.2,,,26.0,526.2
before,claude,500,11,2026-10-15T05:30:54.240Z,512.0,514.4,525.4,529.4,537.4,552.4,573.9,588.8,660.4,26.9,,,10.9,511.1
before,claude,500,12,2026-10-15T05:30:55.973Z,514.9,517.1,542.1,549.1,558.1,581.1,599.5,600.1,644.1,26.8,,,13.5,513.7
before,claude,500,13,2026-10-15T05:30:57.642Z,523.6,525.6,543.1,549.1,556.1,576.1,590.7,591.7,624.4,29.3,,,22.3,522.5
before,claude,500,14,2026-10-15T05:30:59.277Z,528.4,530.1,543.4,546.4,551.4,569.4,582.5,582.8,622.6,37.4,,,27.2,527.4
before,claude,500,15,2026-10-15T05:31:00.872Z,512.5,514.1,523.9,525.9,532.9,548.9,557.1,557.5,594.9,28.4,,,11.8,511.9
before,claude,500,16,2026-10-15T05:31:02.423Z,518.5,520.4,533.7,536.7,541.7,552.7,561.9,562.2,593.4,26.9,,,17.4,517.6
before,claude,500,17,2026-10-15T05:31:03.973Z,513.0,516.1,536.3,541.3,550.3,571.3,592.8,603.8,642.9,26.6,,,11.9,512.0
before,claude,500,18,2026-10-15T05:31:05.575Z,519.0,520.3,532.2,536.2,541.2,553.2,563.7,564.1,590.9,24.4,,,18.1,518.4
before,claude,500,19,2026-10-15T05:31:07.124Z,518.1,519.4,529.8,533.8,539.8,559.8,578.0,578.5,625.9,29.8,,,17.4,517.6
after,codex,0,0,2026-10-15T05:31:44.975Z,17.6,19.0,31.4,37.4,70.4,71.4,73.1,74.4,106.2,23.1,12.9,16.7,10.5,16.5
after,codex,0,1,2026-10-15T05:31:46.139Z,14.6,16.1,25.7,31.7,51.7,54.7,59.1,60.0,93.4,26.6,9.2,13.5,6.8,13.3
after,codex,0,2,2026-10-15T05:31:47.223Z,23.8,25.9,38.4,45.4,68.4,69.4,74.5,75.9,109.2,31.2,15.7,22.3,11.7,21.8
after,codex,0,3,2026-10-15T05:31:48.372Z,18.6,20.2,33.9,41.9,64.9,64.9,65.7,66.1,93.1,27.7,13.4,17.1,9.9,17.0
after,codex,0,4,2026-10-15T05:31:49.475Z,25.1,27.1,41.0,50.0,77.0,78.0,78.2,78.4,106.7,23.6,16.2,22.6,12.0,22.2
after,codex,0,5,2026-10-15T05:31:50.573Z,19.3,26.7,39.8,46.8,76.8,78.8,89.0,89.4,108.2,28.6,12.0,18.2,8.7,17.8
after,codex,0,6,2026-10-15T05:31:51.722Z,24.6,26.8,42.5,50.5,104.5,107.5,110.3,110.8,146.0,33.4,14.2,22.6,10.2,22.1
after,codex,0,7,2026-10-15T05:31:52.973Z,20.1,22.1,36.4,43.4,81.4,82.4,91.0,92.5,126.7,25.8,12.8,18.7,9.6,18.3
after,codex,0,8,2026-10-15T05:31:54.122Z,19.3,20.6,34.4,39.4,70.4,72.4,76.7,77.2,109.3,25.9,12.6,18.0,9.0,17.7
after,codex,0,9,2026-10-15T05:31:55.209Z,37.4,39.8,57.0,66.0,111.0,112.0,112.2,113.0,139.0,32.7,23.0,35.2,16.2,34.7
after,codex,0,10,2026-10-15T05:31:56.425Z,25.9,28.2,44.2,53.2,97.2,98.2,103.8,104.2,122.3,22.4,14.8,21.8,10.9,21.4
after,codex,0,11,2026-10-15T05:31:57.572Z,22.5,26.7,37.1,43.1,80.1,83.1,85.8,86.4,113.7,29.7,17.4,21.4,12.6,21.1
after,codex,0,12,2026-10-15T05:31:58.791Z,34.7,36.6,52.1,58.1,94.1,95.1,99.6,100.3,124.9,29.9,21.3,32.3,14.8,32.0
after,codex,0,13,2026-10-15T05:31:59.957Z,22.6,24.1,38.7,42.7,82.7,83.7,84.2,84.5,107.5,28.3,15.1,21.4,11.3,21.0
after,codex,0,14,2026-10-15T05:32:01.106Z,18.8,20.0,32.8,36.8,76.8,76.8,80.0,80.3,109.1,26.8,12.1,17.6,8.3,17.3
after,codex,0,15,2026-10-15T05:32:02.221Z,18.5,19.9,35.8,41.8,84.8,87.8,90.3,90.8,112.8,28.1,12.2,17.5,8.0,17.1
after,codex,0,16,2026-10-15T05:32:03.323Z,35.6,37.7,56.5,65.5,122.5,123.5,132.4,133.0,159.1,31.5,21.6,33.9,14.5,33.4
after,codex,0,17,2026-10-15T05:32:04.470Z,17.1,18.5,31.1,35.1,72.1,74.1,84.9,85.5,111.1,27.3,10.8,15.8,7.5,15.4
after,codex,0,18,2026-10-15T05:32:05.586Z,18.4,20.4,33.0,37.0,72.0,73.0,83.0,83.4,110.7,30.5,9.5,16.8,6.4,16.5
after,codex,0,19,2026-10-15T05:32:06.675Z,21.6,23.2,45.6,54.6,136.6,140.6,146.6,147.0,173.5,28.2,13.4,20.3,9.1,19.8
after,codex,500,0,2026-10-15T05:32:07.906Z,514.7,516.8,541.4,549.4,599.4,601.4,604.4,604.9,625.4,25.0,13.4,513.5,8.3,508.5
after,codex,500,1,2026-10-15T05:32:09.612Z,524.1,526.2,542.6,548.6,631.6,634.6,636.0,640.2,668.4,31.7,23.0,523.0,15.9,516.1
after,codex,500,2,2026-10-15T05:32:11.405Z,512.2,514.4,524.8,529.8,584.8,585.8,588.7,589.1,608.6,26.1,10.7,510.9,6.9,507.2
after,codex,500,3,2026-10-15T05:32:13.007Z,517.6,519.5,533.8,537.8,614.8,616.8,623.2,624.9,658.9,23.9,16.6,516.7,11.2,511.4
after,codex,500,4,2026-10-15T05:32:14.839Z,515.1,516.8,532.2,536.2,593.2,595.2,600.6,602.7,623.9,24.8,13.9,514.0,8.8,509.0
after,codex,500,5,2026-10-15T05:32:16.491Z,524.4,526.2,545.5,552.5,616.5,620.5,629.7,630.4,660.8,30.6,22.3,523.4,14.6,514.8
after,codex,500,6,2026-10-15T05:32:18.205Z,522.1,524.1,539.3,544.3,601.3,601.3,611.2,611.4,642.3,28.5,21.0,521.1,13.0,513.2
after,codex,500,7,2026-10-15T05:32:19.858Z,524.0,526.1,546.7,556.7,630.7,631.7,637.5,638.2,676.5,30.8,22.3,523.1,14.8,515.1
after,codex,500,8,2026-10-15T05:32:21.672Z,515.6,517.8,539.3,547.3,666.3,671.3,680.1,680.9,711.9,29.9,14.1,514.4,9.6,509.7
after,codex,500,9,2026-10-15T05:32:23.557Z,530.8,533.1,552.3,559.3,634.3,635.3,641.2,642.0,673.9,37.1,29.4,529.5,18.6,518.7
after,codex,500,10,2026-10-15T05:32:25.442Z,532.9,535.3,556.4,561.4,637.4,641.4,651.9,652.6,674.0,43.4,31.2,531.3,22.5,522.6
after,codex,500,11,2026-10-15T05:32:27.254Z,516.5,518.2,534.4,538.4,604.4,606.4,612.6,613.0,643.7,28.1,15.3,515.6,8.1,508.3
after,codex,500,12,2026-10-15T05:32:28.940Z,527.4,529.8,549.5,557.5,642.5,645.5,672.6,684.4,710.9,35.0,25.9,526.0,17.1,517.5
after,codex,500,13,2026-10-15T05:32:30.773Z,517.5,519.0,536.0,540.0,597.0,598.0,605.0,605.4,623.5,26.5,16.7,516.8,11.6,511.8
after,codex,500,14,2026-10-15T05:32:32.490Z,525.0,526.7,547.3,552.3,640.3,642.3,648.4,651.9,675.0,34.1,24.1,524.3,15.3,515.6
after,codex,500,15,2026-10-15T05:32:34.253Z,514.5,516.3,534.9,539.9,606.9,608.9,608.8,611.8,645.6,26.4,13.6,513.7,8.9,509.9
after,codex,500,16,2026-10-15T05:32:35.837Z,513.1,514.7,530.7,537.7,606.7,608.7,611.4,613.8,648.0,25.9,12.0,512.2,7.0,507.1
after,codex,500,17,2026-10-15T05:32:37.521Z,515.3,516.7,540.5,546.5,629.5,630.5,633.6,634.0,658.0,25.0,14.5,514.6,9.6,509.7
after,codex,500,18,2026-10-15T05:32:39.204Z,515.9,517.8,533.2,537.2,612.2,613.2,618.4,618.9,645.1,24.9,14.7,514.8,9.5,509.5
after,codex,500,19,2026-10-15T05:32:40.836Z,515.1,517.2,530.8,536.8,605.8,607.8,614.3,614.7,646.6,27.1,13.9,514.0,8.6,508.8
after,claude,0,0,2026-10-15T05:33:18.633Z,14.7,15.9,22.9,25.9,29.9,42.9,50.6,50.8,78.0,28.5,,,5.8,14.0
after,claude,0,1,2026-10-15T05:33:19.649Z,15.4,16.7,25.3,29.3,37.3,51.3,64.5,64.9,96.4,32.5,,,6.9,14.3
after,claude,0,2,2026-10-15T05:33:20.634Z,17.8,19.0,28.5,31.5,37.5,48.5,61.6,61.9,93.5,27.1,,,10.9,17.0
after,claude,0,3,2026-10-15T05:33:21.669Z,17.7,19.2,32.7,36.7,42.7,56.7,68.3,68.8,108.5,25.8,,,8.2,16.7
after,claude,0,4,2026-10-15T05:33:22.683Z,14.8,16.2,23.9,26.9,30.9,41.9,50.4,50.7,78.0,30.8,,,5.7,14.1
after,claude,0,5,2026-10-15T05:33:23.684Z,22.3,24.3,36.2,41.2,48.2,62.2,81.4,90.7,126.5,30.6,,,11.4,20.9
after,claude,0,6,2026-10-15T05:33:24.782Z,15.0,16.4,22.7,24.7,28.7,39.7,49.0,49.2,80.5,29.5,,,6.6,14.5
after,claude,0,7,2026-10-15T05:33:25.766Z,15.6,17.1,28.4,32.4,40.4,55.4,69.0,69.4,111.2,28.2,,,6.8,14.5
after,claude,0,8,2026-10-15T05:33:26.888Z,30.2,32.1,50.0,58.0,71.0,98.0,126.0,126.9,179.8,28.3,,,14.1,28.8
after,claude,0,9,2026-10-15T05:33:28.122Z,21.4,24.5,44.2,52.2,66.2,108.2,128.4,129.1,171.5,29.2,,,10.5,19.6
after,claude,0,10,2026-10-15T05:33:29.355Z,26.4,29.1,52.1,60.1,68.1,101.1,126.2,141.2,205.2,23.7,,,8.6,24.3
after,claude,0,11,2026-10-15T05:33:30.775Z,36.3,39.1,60.0,68.0,80.0,106.0,125.4,125.9,176.7,33.0,,,17.4,33.9
after,claude,0,12,2026-10-15T05:33:32.157Z,24.9,26.3,42.1,46.1,58.1,83.1,113.8,114.4,153.4,23.5,,,14.8,23.9
after,claude,0,13,2026-10-15T05:33:33.455Z,27.7,29.5,46.8,56.8,65.8,92.8,119.3,119.9,173.4,25.3,,,10.1,25.9
after,claude,0,14,2026-10-15T05:33:34.655Z,20.6,22.2,37.4,40.4,48.4,72.4,88.0,89.0,121.9,25.5,,,11.0,19.1
after,claude,0,15,2026-10-15T05:33:35.819Z,20.3,22.6,38.3,41.3,50.3,74.3,87.3,89.4,124.5,29.9,,,8.8,18.1
after,claude,0,16,2026-10-15T05:33:37.017Z,19.8,21.8,37.4,41.4,49.4,78.4,91.8,92.3,126.5,28.3,,,8.5,18.1
after,claude,0,17,2026-10-15T05:33:38.154Z,30.9,32.9,52.0,58.0,75.0,97.0,116.6,117.1,156.4,29.3,,,16.1,29.7
after,claude,0,18,2026-10-15T05:33:39.320Z,28.4,29.7,44.0,49.0,58.0,79.0,92.9,93.2,124.0,26.7,,,13.3,27.3
after,claude,0,19,2026-10-15T05:33:40.505Z,32.1,34.0,51.0,56.0,63.0,84.0,97.3,97.7,139.3,29.2,,,15.4,29.9
after,claude,500,0,2026-10-15T05:33:41.672Z,517.3,519.1,534.6,541.6,550.6,577.6,597.9,598.7,639.2,32.8,,,16.2,516.4
after,claude,500,1,2026-10-15T05:33:43.453Z,517.3,519.6,537.1,544.1,555.1,585.1,610.7,611.5,662.9,31.5,,,15.6,515.8
after,claude,500,2,2026-10-15T05:33:45.372Z,520.0,522.5,540.6,546.6,555.6,585.6,606.7,607.2,654.9,37.6,,,18.4,518.7
after,claude,500,3,2026-10-15T05:33:47.221Z,516.6,518.2,532.4,536.4,543.4,564.4,583.9,584.5,638.8,26.6,,,15.2,515.4
after,claude,500,4,2026-10-15T05:33:48.904Z,516.6,519.1,534.9,540.9,550.9,575.9,594.3,594.9,639.7,30.2,,,15.0,515.2
after,claude,500,5,2026-10-15T05:33:50.752Z,514.3,517.4,537.2,542.2,552.2,574.2,591.0,592.0,625.3,29.7,,,12.6,512.8
after,claude,500,6,2026-10-15T05:33:52.572Z,518.8,521.1,541.8,546.8,555.8,585.8,608.3,608.9,655.8,35.7,,,17.5,517.7
after,claude,500,7,2026-10-15T05:33:54.403Z,513.5,515.7,535.3,541.3,552.3,582.3,605.7,611.9,673.1,28.1,,,12.3,512.6
after,claude,500,8,2026-10-15T05:33:56.169Z,510.5,517.2,548.3,557.3,573.3,603.3,621.1,621.7,656.8,25.9,,,8.8,509.0
after,claude,500,9,2026-10-15T05:33:58.005Z,517.2,518.8,535.5,540.5,550.5,577.5,592.3,592.9,637.8,35.7,,,16.2,516.3
after,claude,500,10,2026-10-15T05:33:59.719Z,512.1,513.8,537.2,546.2,555.2,574.2,589.9,591.2,640.9,24.1,,,11.2,511.3
after,claude,500,11,2026-10-15T05:34:01.404Z,516.0,518.1,532.7,537.7,544.7,567.7,583.3,583.8,639.0,30.8,,,14.8,514.9
after,claude,500,12,2026-10-15T05:34:03.052Z,514.3,516.7,535.9,539.9,547.9,568.9,585.3,585.8,624.2,30.5,,,13.1,513.2
after,claude,500,13,2026-10-15T05:34:04.769Z,512.6,515.3,582.3,587.3,597.3,619.3,638.1,638.6,674.3,26.6,,,11.1,511.3
after,claude,500,14,2026-10-15T05:34:06.583Z,512.4,514.0,533.6,538.6,546.6,566.6,581.7,582.1,626.0,26.4,,,11.7,511.8
after,claude,500,15,2026-10-15T05:34:08.202Z,515.8,518.3,535.1,539.1,549.1,568.1,583.7,584.3,624.4,32.0,,,14.4,514.6
after,claude,500,16,2026-10-15T05:34:09.831Z,510.0,511.6,529.6,534.6,542.6,563.6,582.6,588.4,644.8,28.3,,,8.6,508.8
after,claude,500,17,2026-10-15T05:34:11.655Z,515.4,518.4,548.1,554.1,567.1,599.1,627.8,628.7,689.7,33.1,,,13.6,513.8
after,claude,500,18,2026-10-15T05:34:13.637Z,514.8,517.4,534.4,542.4,551.4,569.4,585.4,586.1,643.5,32.3,,,13.2,513.4
after,claude,500,19,2026-10-15T05:34:15.336Z,518.1,520.2,548.4,553.4,561.4,580.4,604.3,605.1,662.1,37.0,,,16.4,516.7
```

<details>
<summary>Scratch scheduling ablation, causal regression and browser-chunk mark</summary>

This is the experimental diff for the scheduling change, its focused control and the passive log-bus mark, with blank lines normalized. The native fixture/driver adaptations described above are measurement scaffolding. This diff was executed in scratch and has not been proposed as a publication-ready patch.

```diff
--- a/src/components/TmuxComposer.tsx
+++ b/src/components/TmuxComposer.tsx
@@ -3599,10 +3599,11 @@
           text: requestedText, images: requestedImages, files: requestedFiles, selectedContext,
           runtime: sendRuntime as Record<string, unknown> | undefined, policy,
         });
+        const managerRead = withComposerAdmissionDeadline(
+          isDesignatedManagerConversation(cardId, submittedFile.project), admissionTiming.admissionDeadlineMs,
+        ).catch(() => false);
         const bridge = await drainBridgeTurnStart();
-        const prelude = await withComposerAdmissionDeadline(
-          isDesignatedManagerConversation(cardId, submittedFile.project), admissionTiming.admissionDeadlineMs,
-        ).catch(() => false)
+        const prelude = await managerRead
           ? viewerContextPrelude({ path: submittedFile.path, project: submittedFile.project }) : "";
         const taskLines = taskReferencePrelude(selectedContext.tasks);
         const composed = [taskLines, prelude, requestedText].filter(Boolean).join("\n");
@@ -3893,6 +3894,9 @@
        reported while nothing was live rides in with it. Never on a replay — a
        retained generation replays its original bytes under its original key, and
        changing them would defeat the idempotency the retry exists for. */
+    const managerRead = durable || replayGeneration ? Promise.resolve(false) : withComposerAdmissionDeadline(
+      isDesignatedManagerConversation(cardId, file.project), admissionTiming.admissionDeadlineMs,
+    ).catch(() => false);
     const bridgeTurn = durable || replayGeneration ? null : await drainBridgeTurnStart();
     /* The Viewer-global orchestrator travels with the operator: what they are
        looking at right now — current project, focused conversation, explicit
@@ -3909,9 +3913,7 @@
        queried per dispatch and cached. */
     // This optional read precedes admission. A lost seat response must not hold
     // the local wire fence forever; an unconfirmed designation adds no context.
-    const viewerPrelude = durable || replayGeneration || !(await withComposerAdmissionDeadline(
-      isDesignatedManagerConversation(cardId, file.project), admissionTiming.admissionDeadlineMs,
-    ).catch(() => false))
+    const viewerPrelude = durable || replayGeneration || !(await managerRead)
       ? ""
       : viewerContextPrelude({ path: file.path, project: file.project });
     const composedText = [taskReferencePrelude(selectedContext?.tasks), viewerPrelude, requestedText].filter(Boolean).join("\n");
--- a/src/components/TmuxComposer.viewerPrelude.dom.test.tsx
+++ b/src/components/TmuxComposer.viewerPrelude.dom.test.tsx
@@ -142,7 +142,7 @@

 /** Type a draft into the real composer and submit it the way the Send button
     does, then let the queue drain onto the wire. */
-async function sendThrough(file: FileEntry, text: string): Promise<void> {
+async function sendThrough(file: FileEntry, text: string, beforeSubmit?: () => void): Promise<void> {
   const host = document.createElement("div");
   document.body.append(host);
   const root = createRoot(host);
@@ -156,6 +156,7 @@
     await new Promise((r) => setTimeout(r, 0));
   });
   await act(async () => {
+    beforeSubmit?.();
     (host.querySelector("form") as HTMLFormElement)
       .dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
     for (let tick = 0; tick < 12; tick += 1) await new Promise((r) => setTimeout(r, 0));
@@ -225,3 +226,31 @@
   await sendThrough(fileFor(MANAGER, "manager_prelude"), "still just a message");
   expect(sentTexts).toEqual(["still just a message"]);
 });
+
+
+test("manager identity starts while the bridge drain waits; one payload keeps both preludes", async () => {
+  const original=globalThis.fetch;
+  let release!:()=>void;
+  const held=new Promise<void>(resolve=>{release=resolve;});
+  let seatReads=0;
+  let bridgeReads=0;
+  globalThis.fetch=(async(input:unknown,init?:RequestInit)=>{
+    const url=String(input);
+    if(url.startsWith('/api/bridge?')){bridgeReads++;await held;return Response.json({ok:true,prelude:{text:'Retained bridge report.',ackToken:'fixture-bridge-ack'}});}
+    if(url.startsWith('/api/orchestrator/seat?'))seatReads++;
+    return original(input as RequestInfo,init);
+  }) as typeof fetch;
+  try {
+    await sendThrough(fileFor(MANAGER,'manager_overlap'),'Keep this authored message.',()=>{resetManagerIdentityForTest();seatReads=0;});
+    expect(bridgeReads).toBe(1);
+    expect(sentTexts).toHaveLength(0);
+    expect(seatReads).toBe(1);
+  } finally {
+    release();
+    await act(async()=>{for(let i=0;i<20;i++)await new Promise(r=>setTimeout(r,0));});
+  }
+  expect(sentTexts).toHaveLength(1);
+  expect(sentTexts[0]).toStartWith('Retained bridge report.');
+  expect(sentTexts[0]).toContain('[viewer context');
+  expect(sentTexts[0]).toEndWith('Keep this authored message.');
+});
--- a/src/hooks/logBus.ts
+++ b/src/hooks/logBus.ts
@@ -152,6 +152,8 @@
 }

 function deliverStreamChunk(id: string, chunk: LogTailStreamResult): void {
+  const audit=(globalThis as any).nativePaintAudit;
+  if(audit && !audit.browserChunk && JSON.stringify(chunk).includes(audit.text)) audit.browserChunk=performance.timeOrigin+performance.now();
   const sub = connectedSubs.get(id);
   if (!sub || !subs.has(sub)) return;
   sub.onChunk(chunk);
```

</details>
