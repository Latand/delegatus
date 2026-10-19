# Seat inbox coalescing verification

The acceptance input (six answers, one operator chat and one seat wake admitted during a running Claude seat turn) reaches one `host.send`, with eight verbatim parts in admission order, eight delivered receipts sharing one turn id and zero interrupts. Overflow selects operator chat for the first message and preserves ordinary admission order across later messages. The existing queue remains the inbox.

## Base and neighbouring lanes

Base: `9f4e5cfd8d6167e23b1233e827b8aeb2091459b0`. `git merge-base --is-ancestor 4119ffba3 9f4e5cfd8d6167e23b1233e827b8aeb2091459b0` exited 0: the seat single-channel change (#2981) is present. The pinned design is already in this base. Actual fenced diffs were read before shared edits, then checked again before handover:

| Lane | Inspected revision | Shared scope respected |
| --- | --- | --- |
| MCP/state concurrency | `442282e51c065fa4071d75227e407abbffce35c6` | Existing MCP imports/handlers and broker test hunks kept separate |
| Memory launch settings | `20a793f2a4d9b8d129a6318086775bd72dc65600` | Launch settings and their tests untouched |
| Publication CPU queue | `6082b5de541b6ea64d20315817ffbbe710f99e9c` | Publication and gate-slot sources untouched |
| Receipt field-index seeks | `5fdea7a4e2c3f93cc602fd79e6f4e0a7a26cfab6` | Registry query implementation untouched; monitor operation label is outside diagnostic revision hunks |

The final observed `origin/main` was `afafbfba9`; its five paths added since the base concern release workflows and documentation, with no overlap here. No merge or branch switch was needed.

## Shared contract inventory

| Optional field or write | Producers, defaults, copies and consumers checked |
| --- | --- |
| `QueueEntry.parts` | Queue composer produces it; ordinary spawn, recovery, worker and Codex entries omit it. `normalizeQueueEntry` clones it; the Claude ledger retains it on replay and compares it on retries; the broker writes header/image/body blocks and emits member ids. Provenance, receipt confirmation and feed/MCP attribution consume it. |
| `DeliveryOperationOwner.batchId` | One off-loop atomic registry mutation binds every selected owner and generation before the host write. Normalization preserves valid ids; terminal settlement and retention preserve owner evidence. New retry owners omit old membership; generation rebinding clears an unwritten batch before a new single dispatch. All receipt readers continue through `confirmedSend`. |
| `deliveryEcho.memberOperationIds` | Broker copies ids from its retained layout. Controller stamps each matching conversation member once, preserving separate ingress timestamps. Historical echoes do not invent observation times. |
| Per-part provenance | Claude ledger UUID joins verified layout, each member origin, submission, selected context and seat mandate. The feed splits only proven parts. `conversation_messages` retains one record and adds bounded author/range metadata; whole-row author fallback is skipped for a batch. Single records keep their existing default. |
| Seat eligibility | The shared recipient index owns a set of active seat conversations, rebuilt on hydration and updated on seat writes. Only affirmative current-seat evidence enables coalescing; the single-channel verdict and per-member dispatch authorization run again at the engine write. |

No journal schema, runtime-host, launcher, Dockerfile, SQLite query or publication code changed. No speed gain is claimed.

## Procedure and final runs

Checks ran from scratch exports with frozen dependencies, under Bun 1.4.0. Every test file received its own private `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR`, with `NODE_ENV=test` and `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`. Every heavy command used the supplied gate-slot runner, byte-identical to the base's `scripts/gate-slot.sh` (SHA-256 `6ac5728ddc87d13ef5e3fb1ea7ad534b9c8b8da0d166def646a6d00ab1986f31`). Commands below use its repository-relative name. A fresh sandbox can be prepared under the stage-owned temporary directory before each command:

```sh
sandbox=$(mktemp -d "${TMPDIR:?}/seat-inbox-check.XXXXXX")
mkdir -p "$sandbox/home" "$sandbox/config" "$sandbox/tmp" "$sandbox/state"
export HOME="$sandbox/home" XDG_CONFIG_HOME="$sandbox/config"
export TMPDIR="$sandbox/tmp" LLV_STATE_DIR="$sandbox/state"
export LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1 NODE_ENV=test
```

The native CLI file additionally receives `LLV_CLAUDE_BINARY` naming the installed Claude binary and talks only to its own loopback API. The browser case receives `LLV_CONVERSATION_BROWSER_TEST=1` and `CHROME_BIN` naming installed Chromium. It starts its own server on port 0. Cleanup stops only the handles each fixture creates.

| Test file | New cases red on base | Final full-file passes | Existing failures |
| --- | ---: | ---: | ---: |
| `src/components/conversation/conversationWindow.browser.test.tsx` | 1 | 1 | 0 |
| `src/components/feed/inboxBatch.test.ts` | 1 | 1 | 0 |
| `src/lib/orchestrator/seatChannel.test.ts` | 1 | 21 | 0 |
| `src/lib/runtime/agentRecordAuthors.test.ts` | 2 | 2 | 0 |
| `src/lib/runtime/claudeMessageProvenance.test.ts` | 2 | 14 | 2 |
| `src/lib/runtime/claudeStreamBrokerHost.nativeQueue.test.ts` | 1 | 4 | 0 |
| `src/lib/runtime/claudeStreamBrokerHost.test.ts` | 1 | 125 | 0 |
| `src/lib/runtime/inboxBatch.test.ts` | 4 | 4 | 0 |
| `src/lib/runtime/sendSettlement.test.ts` | 13 | 82 | 0 |
| `src/lib/runtime/structuredDeliveryController.test.ts` | 1 | 5 | 0 |
| `src/lib/runtime/structuredDeliveryQueue.test.ts` | 13 | 153 | 0 |

All 40 new cases are green. These are the final per-file commands (the browser command selects this change's case within the existing driver):

```sh
bash scripts/gate-slot.sh bun test src/components/conversation/conversationWindow.browser.test.tsx --test-name-pattern 'seat inbox|inbox composer|seat-inbox'
bash scripts/gate-slot.sh bun test src/components/feed/inboxBatch.test.ts
bash scripts/gate-slot.sh bun test src/lib/orchestrator/seatChannel.test.ts
bash scripts/gate-slot.sh bun test src/lib/runtime/agentRecordAuthors.test.ts
bash scripts/gate-slot.sh bun test src/lib/runtime/claudeMessageProvenance.test.ts
bash scripts/gate-slot.sh bun test src/lib/runtime/claudeStreamBrokerHost.nativeQueue.test.ts
bash scripts/gate-slot.sh bun test src/lib/runtime/claudeStreamBrokerHost.test.ts
bash scripts/gate-slot.sh bun test src/lib/runtime/inboxBatch.test.ts
bash scripts/gate-slot.sh bun test src/lib/runtime/sendSettlement.test.ts
bash scripts/gate-slot.sh bun test src/lib/runtime/structuredDeliveryController.test.ts
bash scripts/gate-slot.sh bun test src/lib/runtime/structuredDeliveryQueue.test.ts
bash scripts/gate-slot.sh bun test src/lib/runtime/claudeMessageProvenance.test.ts --test-name-pattern 'seat inbox|inbox composer|seat-inbox'
bash scripts/gate-slot.sh bun node_modules/typescript/bin/tsc --noEmit --incremental false
bash scripts/gate-slot.sh bun scripts/eslint-changes.ts --base 9f4e5cfd8d6167e23b1233e827b8aeb2091459b0 <each changed TypeScript path listed below>
bash scripts/gate-slot.sh bun scripts/privacy-publication-gate.ts --base 9f4e5cfd8d6167e23b1233e827b8aeb2091459b0 --require-known-values
```

The evidence JSON stores the complete explicit lint argv and source SHA-256 values. Typecheck exits 0. The privacy publication gate exits 0 with `PRIVACY GATE: PASS`. Project changed-file lint reports zero introduced errors and four existing `react-hooks/refs` errors in `LogFeed.tsx`; the same four were reproduced by raw ESLint on the base. The project gate compares diagnostics against the base.

The full provenance file has two pre-existing failures: `rotation UUID retains custom mandate from active seat with stamped operator origin` and its `from history` counterpart. The same full-file command (`bash scripts/gate-slot.sh bun test src/lib/runtime/claudeMessageProvenance.test.ts`) was run with the same isolation on the base; both fail there with the same assertion (expected custom mandate, received version 44). Its two added inbox cases pass when selected explicitly; no unrelated mandate behavior was changed.

The browser case renders four separate bubbles in en/uk, light/dark, at 390 and 1280 pixels, with no horizontal overflow. All eight final frames were visually inspected: operator chat and two saved answers keep their operator bubbles; the relay keeps its reviewer card; agent-facing headers stay hidden. `evidence/seat-inbox-render.json` records the eight results. Frames are generated under `.artifacts/seat-inbox` in the scratch export.

## Red-on-base evidence

Tests were written before implementation. The final test sources were replayed against an archive of the base, adding only those tests and their independent test fixture. Every command below exited 1 with the named assertions. The evidence JSON retains the complete assertion diagnostics (including expected/received values) and the command for every file.


### `src/components/conversation/conversationWindow.browser.test.tsx`

```sh
bash scripts/gate-slot.sh bun test src/components/conversation/conversationWindow.browser.test.tsx --test-name-pattern 'seat inbox|inbox composer|seat-inbox'
```

- **seat inbox attribution > four combined parts render their own bubbles in both languages and themes** — `expect(subject?.composeBatch).toBeFunction();`; error: expect(received).toBeFunction()

### `src/components/feed/inboxBatch.test.ts`

```sh
bash scripts/gate-slot.sh bun test src/components/feed/inboxBatch.test.ts --test-name-pattern 'seat inbox|inbox composer|seat-inbox'
```

- **seat inbox parser splits a combined row only from its part evidence** — `expect(subject.splitInboxBatchFeed).toBeFunction();`; error: expect(received).toBeFunction()

### `src/lib/orchestrator/seatChannel.test.ts`

```sh
bash scripts/gate-slot.sh bun test src/lib/orchestrator/seatChannel.test.ts --test-name-pattern 'seat inbox|inbox composer|seat-inbox'
```

- **seat inbox revocation composes with channel, owner and epoch reconciliation** — `expect(isCurrentOrchestratorSeat).toBeFunction();`; error: expect(received).toBeFunction()

### `src/lib/runtime/agentRecordAuthors.test.ts`

```sh
bash scripts/gate-slot.sh bun test src/lib/runtime/agentRecordAuthors.test.ts --test-name-pattern 'seat inbox|inbox composer|seat-inbox'
```

- **seat inbox conversation records keep per-part authors and no whole-row operator attribution** — `expect(subject.agentRecordPartAuthors).toBeFunction();`; error: expect(received).toBeFunction()
- **seat inbox conversation_messages keeps one row and returns bounded part author ranges** — `expect(response.records[0]!.parts?.map(p => p.author.kind)).toEqual(["operator", "agent"]);`; error: expect(received).toEqual(expected)

### `src/lib/runtime/claudeMessageProvenance.test.ts`

```sh
bash scripts/gate-slot.sh bun test src/lib/runtime/claudeMessageProvenance.test.ts --test-name-pattern 'seat inbox|inbox composer|seat-inbox'
```

- **seat inbox provenance gives each member its own author and submission** — `expect(map["batch-user-uuid"]?.parts?.map(p => ({ text: p.text, origin: p.provenance.origin })))`; error: expect(received).toEqual(expected)
- **seat inbox preserves a seat mandate's own provenance inside a combined input** — `expect(map["batch-mandate-uuid"]?.parts?.[0]!.provenance.mandate).toEqual({ kind: "version", version: 44 });`; error: expect(received).toEqual(expected)

### `src/lib/runtime/claudeStreamBrokerHost.nativeQueue.test.ts`

```sh
bash scripts/gate-slot.sh bun test src/lib/runtime/claudeStreamBrokerHost.nativeQueue.test.ts --test-name-pattern 'seat inbox|inbox composer|seat-inbox'
```

- **installed Claude queue protocol with loopback API: seat-inbox** — `expect(rows[1]!.entry.parts?.map(p => p.operationId)).toEqual(answers.map(a => a.operationId));`; error: expect(received).toEqual(expected)

### `src/lib/runtime/claudeStreamBrokerHost.test.ts`

```sh
bash scripts/gate-slot.sh bun test src/lib/runtime/claudeStreamBrokerHost.test.ts --test-name-pattern 'seat inbox|inbox composer|seat-inbox'
```

- **seat inbox broker persists layout before writing and refuses a changed layout under the same id** — `expect(blocks).toHaveLength(4);`; error: expect(received).toHaveLength(expected)

### `src/lib/runtime/inboxBatch.test.ts`

```sh
bash scripts/gate-slot.sh bun test src/lib/runtime/inboxBatch.test.ts --test-name-pattern 'seat inbox|inbox composer|seat-inbox'
```

- **inbox composer fits operator chat with the first two ordinary messages** — `expect(subject?.composeBatch).toBeFunction();`; error: expect(received).toBeFunction()
- **inbox composer never skips a priority member to fit ordinary messages** — `expect(subject?.composeBatch).toBeFunction();`; error: expect(received).toBeFunction()
- **inbox composer respects image count and raw image budget and leaves a near-limit member alone** — `expect(subject?.composeBatch).toBeFunction();`; error: expect(received).toBeFunction()
- **inbox composer deduplicates only the same origin and restores every exact part** — `expect(subject?.composeBatch).toBeFunction();`; error: expect(received).toBeFunction()

### `src/lib/runtime/sendSettlement.test.ts`

```sh
bash scripts/gate-slot.sh bun test src/lib/runtime/sendSettlement.test.ts --test-name-pattern 'seat inbox|inbox composer|seat-inbox'
```

- **seat inbox restart: receipt confirms every original member with no resend** — `expect(JSON.parse(freshReader.stdout)).toEqual([true, true, true]);`; error: expect(received).toEqual(expected)
- **seat inbox restart: projection confirms every original member with no resend** — `expect(JSON.parse(freshReader.stdout)).toEqual([true, true, true]);`; error: expect(received).toEqual(expected)
- **seat inbox restart: startup confirms every original member with no resend** — `expect(JSON.parse(freshReader.stdout)).toEqual([true, true, true]);`; error: expect(received).toEqual(expected)
- **seat inbox restart: original-key confirms every original member with no resend** — `expect(JSON.parse(freshReader.stdout)).toEqual([true, true, true]);`; error: expect(received).toEqual(expected)
- **seat inbox restart: retry confirms every original member with no resend** — `expect(JSON.parse(freshReader.stdout)).toEqual([true, true, true]);`; error: expect(received).toEqual(expected)
- **seat inbox evidence refuses missing-binding** — `expect(registry.bindDeliveryBatchOffLoop).toBeFunction();`; error: expect(received).toBeFunction()
- **seat inbox evidence refuses missing-parts** — `expect(registry.bindDeliveryBatchOffLoop).toBeFunction();`; error: expect(received).toBeFunction()
- **seat inbox evidence refuses omitted-member** — `expect(registry.bindDeliveryBatchOffLoop).toBeFunction();`; error: expect(received).toBeFunction()
- **seat inbox evidence refuses part-digest** — `expect(registry.bindDeliveryBatchOffLoop).toBeFunction();`; error: expect(received).toBeFunction()
- **seat inbox evidence refuses batch-id** — `expect(registry.bindDeliveryBatchOffLoop).toBeFunction();`; error: expect(received).toBeFunction()
- **seat inbox evidence refuses no-echo** — `expect(registry.bindDeliveryBatchOffLoop).toBeFunction();`; error: expect(received).toBeFunction()
- **seat inbox evidence refuses codex** — `expect(registry.bindDeliveryBatchOffLoop).toBeFunction();`; error: expect(received).toBeFunction()
- **seat inbox registry binding is atomic and a subsequent single dispatch clears an unwritten batch** — `expect(active.registry.bindDeliveryBatchOffLoop).toBeFunction();`; error: expect(received).toBeFunction()

### `src/lib/runtime/structuredDeliveryController.test.ts`

```sh
bash scripts/gate-slot.sh bun test src/lib/runtime/structuredDeliveryController.test.ts --test-name-pattern 'seat inbox|inbox composer|seat-inbox'
```

- **seat inbox echo stamps every member once with its own ingress and excludes history** — `expect(subject.observeDeliveryEcho).toBeFunction();`; error: expect(received).toBeFunction()

### `src/lib/runtime/structuredDeliveryQueue.test.ts`

```sh
bash scripts/gate-slot.sh bun test src/lib/runtime/structuredDeliveryQueue.test.ts --test-name-pattern 'seat inbox|inbox composer|seat-inbox'
```

- **seat inbox acceptance: six answers, chat and wake reach one turn without interrupt** — `expect(h.sends[0]!.parts?.map(p => p.operationId)).toEqual(h.inputs.map(e => String(e.payload.operationId)));`; error: expect(received).toEqual(expected)
- **seat inbox priority preserves ordinary admission order across a forty-message backlog** — `expect(h.sends).toHaveLength(20);`; error: expect(received).toHaveLength(expected)
- **seat inbox stale-turn returns every member to queued** — `expect(h.sends[0]!.parts).toHaveLength(3);`; error: Received value does not have a length property: undefined
- **seat inbox dead-host returns every member to queued** — `expect(h.sends[0]!.parts).toHaveLength(3);`; error: Received value does not have a length property: undefined
- **seat inbox unknown write terminalizes every member and never resends** — `expect(h.sends).toHaveLength(1);`; error: expect(received).toHaveLength(expected)
- **seat inbox binding refusal sends nothing and releases every delivering member** — `expect(h.sends).toHaveLength(0);`; error: expect(received).toHaveLength(expected)
- **seat inbox excludes a lost compare-and-set and recomputes membership** — `expect(h.sends[0]!.parts?.map(p => p.operationId)).toEqual(["inbox-0", "inbox-2"]);`; error: expect(received).toEqual(expected)
- **seat inbox per-member authorization refusal at preparation fails only that member before recomposition** — `expect(h.sends).toHaveLength(0);`; error: expect(received).toHaveLength(expected)
- **seat inbox per-member authorization refusal at after-binding fails only that member before recomposition** — `expect(h.sends).toHaveLength(0);`; error: expect(received).toHaveLength(expected)
- **seat inbox revoked at engine write applies to the entire batch** — `expect(h.sends).toHaveLength(0);`; error: expect(received).toHaveLength(expected)
- **seat inbox unknown at engine write applies to the entire batch** — `expect(h.sends).toHaveLength(0);`; error: expect(received).toHaveLength(expected)
- **seat inbox scope falls back to individual sends when eligibility is false** — `expect(positive.sends[0]!.parts).toHaveLength(3);`; error: Received value does not have a length property: undefined
- **seat inbox scope falls back to individual sends when eligibility is undefined** — `expect(positive.sends[0]!.parts).toHaveLength(3);`; error: Received value does not have a length property: undefined

## Deferrals and later stages

No implementation item from steps 0–5 was deliberately deferred. The design's exclusions remain: an idle gather timer (adds lone-message latency), Claude mid-turn injection (depends on #2742), worker/stage batching (different turn accounting), Codex batching/queue steering (existing steering and fence behavior), cross-producer duplicate elimination (producer ownership), rewriting (verbatim requirement), larger bounds (current limits), a second inbox store (existing journal), the independent Viewer stall and the settlement window.

The independent review rounds and required hosted checks run after pipeline publication; this builder neither pushes nor opens a pull request. Deployment and the design's seven-day p90 comparison require the later deployed observation window. The synthetic acceptance and distinct-ingress/shared-echo checks are complete; this report makes no production latency claim and reads no live state.

## Every changed file

- `docs/verification/seat-inbox-coalescing.md`
- `evidence/seat-inbox-render.json`
- `evidence/seat-inbox-verification.json`
- `src/components/LogFeed.tsx`
- `src/components/conversation/conversationWindow.browser.test.tsx`
- `src/components/conversation/conversationWindowEvidence.fixture.tsx`
- `src/components/feed/inboxBatch.test.ts`
- `src/components/feed/messageProvenance.tsx`
- `src/components/feed/parse.ts`
- `src/lib/agent/registry.ts`
- `src/lib/mcp/bindings.ts`
- `src/lib/orchestrator/seatChannel.test.ts`
- `src/lib/orchestrator/seats.ts`
- `src/lib/runtime/agentRecordAuthors.test.ts`
- `src/lib/runtime/agentRecordAuthors.ts`
- `src/lib/runtime/claudeMessageProvenance.test.ts`
- `src/lib/runtime/claudeMessageProvenance.ts`
- `src/lib/runtime/claudeStreamBrokerHost.nativeQueue.test.ts`
- `src/lib/runtime/claudeStreamBrokerHost.test.ts`
- `src/lib/runtime/claudeStreamBrokerHost.ts`
- `src/lib/runtime/confirmedSend.ts`
- `src/lib/runtime/engineHost.ts`
- `src/lib/runtime/fixtures/inboxBatch.ts`
- `src/lib/runtime/inboxBatch.test.ts`
- `src/lib/runtime/inboxBatch.ts`
- `src/lib/runtime/messageOrigin.ts`
- `src/lib/runtime/sendSettlement.test.ts`
- `src/lib/runtime/sendSettlement.ts`
- `src/lib/runtime/structuredDeliveryController.test.ts`
- `src/lib/runtime/structuredDeliveryController.ts`
- `src/lib/runtime/structuredDeliveryQueue.test.ts`
- `src/lib/runtime/structuredDeliveryQueue.ts`
- `src/lib/viewerLoopMonitor.ts`
