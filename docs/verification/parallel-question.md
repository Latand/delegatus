# Parallel question delivery and retry

A busy seat can fork its history successfully while its first message never
starts a host. The investigation on 2026-10-15 found the fork registration at
20:36:13.566 UTC, the send reservation at 20:36:15.054, and a failed resume at
20:36:16.572. The membership prerequisite was false and the receipt had no host
binding. The journal at 20:36:16.570 reported task-store contention. The fork
still matched its copied history and contained no new question. These records
support a launch refusal before host creation; they do not establish child
process death.

The diagnosis used read-only SQLite queries against the conversation's registry
rows and delivery progress, plus the service journal for
20:35:50–20:36:30 UTC. No production send or runtime mutation was used.

| Criterion | Change | Regression and evidence |
| --- | --- | --- |
| A: explain the missing question | Preserve typed pre-commit contention. Reserve once, then asynchronously retry task membership outside writer leases under one deadline. Recheck authority after each wait. | `src/lib/tasks/launchMembership.test.ts`: typed refusal, one uncorrelated reservation, peer-held SQLite lock and racing revocation. Main fails; head passes. |
| B: deliver to the fork | The normal migration drain admits assigned sends carrying durable reclaimed-host intent. The existing claims, actuation section and uncertain-delivery fences still govern dispatch. | `src/lib/accounts/migration/coordinator.test.ts` and `src/lib/runtime/structuredMessageDelivery.test.ts`: reopen the registry, resume the recipient and deliver the saved question once. Main skips the send; head drains it. |
| C: visible failure and retry | Keep the text, author and content-addressed images. Track first-delivery outcome, show its reason beside the question, and offer Retry. Retry checks and settles the previous operation before reopening the same fork with a durable attempt key. | Command, production-port, sweep, route and DOM tests under `src/lib/orchestrator/`, `src/app/api/orchestrator/ghost/` and `src/components/conversation/`. Browser readings: `evidence/parallel-question/readings.json`. |

A held first message stays pending until delivery is confirmed. Its failure
ends with the actual delivery reason instead of being inferred as a dead host.
Retry keeps the fork's history and original author. A reservation with zero
attempts and no journal operation is cancelled under the registry writer before
the next attempt; a claim that arrives during that read prevents the cancellation. It checks the current seat
and epoch, refuses concurrent actuation and unverified earlier delivery, and
preserves the question on refusal. An older record can recover its attachment
references from the original delivery reservation. Missing attachment bytes
produce a visible refusal. Ordinary messages to deputy conversations remain
refused; the pending attempt's exact message key is the admitted exception.

The optional record fields preserve schema version 1. Legacy records default to
attempt zero. Image collection retains references while the deputy record is
retained; trimming that record releases its reachability contribution.

## Reproduce

Use a clean source export, a private HOME, XDG_CONFIG_HOME, TMPDIR and
LLV_STATE_DIR, and the project's `scripts/gate-slot.sh` wrapper. Test files are
selected explicitly; no runtime directory sweep is needed.

```sh
bun test src/lib/tasks/launchMembership.test.ts
bun test src/lib/accounts/migration/coordinator.test.ts
bun test src/lib/runtime/structuredMessageDelivery.test.ts
bun test src/lib/orchestrator/deputyCommand.test.ts
bun test src/lib/orchestrator/deputyCommandPorts.test.ts
bun test src/lib/orchestrator/deputySweep.test.ts
bun test src/app/api/orchestrator/ghost/route.test.ts
bun test src/components/conversation/DeputyBlock.dom.test.tsx
LLV_CONVERSATION_BROWSER_TEST=1 bun test src/components/conversation/conversationWindow.browser.test.tsx -t 'parallel question failure'
```

Set CHROME_BIN to an installed Chromium binary for the browser command.
The existing conversation-window driver renders 390 × 900 and 1280 × 900,
English and Ukrainian, light and dark. It captures failure, retry refusal and
accepted retry, checks geometry and the exact retry request, and records
`evidence/parallel-question/readings.json`. The command results and source revision
are in `evidence/parallel-question/regressions.json`. Frames are generated under
`.artifacts/parallel-question/`. The driver keeps Chromium's temporary directory
inside the isolated scratch root through a short directory-handle path on Linux.

Regression evidence is recorded against main `05f90f84d` and the candidate
source. The checks use simulated engine transport and private journals; they do
not call a paid model or exercise the operator's running installation. No
performance improvement is claimed. Runtime-host source and the Bun pin are
unchanged.
