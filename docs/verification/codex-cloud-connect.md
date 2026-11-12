# Codex Cloud registry connect

To inspect a Cloud stage, read `get_pipeline` with `stageId`. Its `attempt.execution`
shows the requested runtime, actual execution runtime and failure reason.
`list_pipelines` and compact/full reads retain the same evidence. A failed
Codex Cloud stage stops; select `runtime: local` explicitly to run locally.
For creation with a source conversation, supply `inputContext.handoffDigest`.
An omitted model resolves from the bound role.

For progress, use a full pipeline read: each attempt's `cloud` records its phase,
next poll time, error and, after acceptance, task URL. A receiptless unresolved
submission reports execution runtime `unknown`; legacy failed submissions
without explicit no-work proof retain that uncertainty. New Codex Cloud failures
stop automatically; saved local-fallback intents remain visible when recovered.

## Cause evidence before implementation

The initial investigation read the public issue, saved binding and failed stage,
and a prior independent provider reproduction from 2026-10-25. That reproduction
received ten registry-offline refusals, then succeeded with the unchanged request
around 30 seconds after thread creation.

At the starting revision `15099450d8759bd28662bcccf18bfc1da0d4702b`,
`src/lib/pipelines/cloudHostedClient.ts:422` built
`thread/start`, including `deferredEnvironment: true` at line 425. Lines 439–440
immediately built the lane checkout request. The shared `execute` function at
lines 353–355 built `command/exec`, selecting the runtime environment returned by
the thread.
`src/lib/projects/codexCloudEnvironments.ts:272` marked the binding ready from
configuration-version validation, independently of a new runtime's connection.

## Single manual provider probe

One authorized subscription account was probed on 2026-11-12, from 13:52:19 UTC
to 13:53:07 UTC. Two earlier local authentication attempts stopped before opening
any provider socket. Local CLI inspection established that Bun's `userInfo()`
followed the isolated HOME; the probe then explicitly selected the authorized
account home. No settings or credential mutation was requested.

The probe opened one authenticated provider socket, resolved the existing
composite configuration, and created one deferred thread. It repeated only the
read-only `git rev-parse HEAD` request with unchanged parameters:

| Observation | Result |
| --- | --- |
| First eight command requests | RPC `-32602`, registry HTTP 409, `environment_offline` |
| Ninth identical command | Exit 0 at 34.452 seconds from probe start |
| Work turn | One accepted turn on `gpt-6.1-sol` |
| Terminal observation | Completed, no error, at 49.134 seconds |

The account, composite configuration, runtime environment and thread were held
constant. No environment was replaced or reconfigured, and no competing connection
was stopped. The same request succeeding after the wait establishes deferred
runtime startup as this 409's cause. A malformed composite ID, principal mismatch
or deleted environment would not explain that unchanged request's success.

The model turn requested one read-only commit query and completed without a
provider error. No diff was imported into the lane, and no commit or push was
made by the probe. Provider identities remain in the private receipts. The probe
establishes registry readiness and one real Cloud turn. Lane branch checkout, model fidelity, verdict
settlement and failure handling are exercised with provider fakes.

## Regression procedure

Each explicit test file runs in its own isolated gate-slot command from a scratch
export with private HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR. Provider
transports are fakes, remapped to owned loopback listeners where applicable.

Coverage includes delayed connect success, bounded exhaustion, cancellation and
authority changes; no retry of unknown conflicts; durable binding invalidation
and stale refusal guards; no automatic local launch for a Codex Cloud stage;
role model resolution; SDK admission refusal with
`structuredContent.details.outcome: not-executed`; and
runtime identity across list, full/compact detail, stage result and board reads.
The existing board browser driver covers both languages and themes.

In the final implementation, `src/lib/pipelines/cloudHostedClient.ts:357` builds
the command request, line 360 owns the startup wait, and
`src/lib/projects/codexCloudEnvironments.ts:215` records a failed connect against
the exact admitted binding.

## Verification results

Each row below used a separate gate command, with
`scripts/gate-slot.sh bun test --timeout=60000 <file>` and the isolated roots
above. The browser command additionally selected `-t "where a stage ran"` and
enabled the existing browser driver's environment switch.

| Test file | Passed |
| --- | ---: |
| `src/lib/pipelines/cloudHostedClient.test.ts` | 155 |
| `src/lib/projects/codexCloudEnvironments.test.ts` | 84 |
| `src/lib/pipelines/engine.cloud.test.ts` | 136 |
| `src/lib/pipelines/cloudStage.test.ts` | 14 |
| `src/lib/pipelines/listProjection.test.ts` | 28 |
| `src/lib/mcp/compactAnswers.test.ts` | 26 |
| `src/lib/mcp/pipelineSource.integration.test.ts` | 36 |
| `src/lib/pipelines/engine.claudeCloud.test.ts` | 11 |
| `src/components/kanban/stageIdentity.test.ts` | 19 |
| `src/components/kanban/StageGlyph.dom.test.tsx` | 13 |
| `src/components/kanban/kanbanBoard.browser.test.tsx` (selected case) | 1 |

The browser case produced 24 frames covering cards, graph nodes and stage panes
in both languages and themes at two widths. After the fallback label changed,
the graph clipped a model name. The base with the same browser isolation passed;
the candidate passed after allowing that label its own graph row.

The base's hosted-client regression failed at the first registry-offline refusal.
The original base engine file also had a fixed post-release deadline assertion
that expired while the owner's real budget remained. With the same corrected
deadline harness, the base passed all 134 tests and the candidate passed 136.
The compact fixture needed current caller authority and all Codex home aliases
isolated; its old 1,600-byte create acknowledgement ceiling failed at 2,134 bytes
on both the base and candidate after that fixture repair. The ceiling now includes
the existing delivery and memory-cap acknowledgement.

An interrupted projection check ended with status 143 in CPU admission, before
Bun or state writes. Its terminal receipt was reconciled before the fresh,
successful 28-test run. It supplies no test verdict.

Required final checks are the isolated
`scripts/gate-slot.sh bun node_modules/typescript/bin/tsc --noEmit --incremental false`,
the repository's staged whitespace/ESLint hook, and
`scripts/gate-slot.sh bun run privacy:check` on the final commit.
Exact revisions, commands, source hashes, terminal receipts and the private
provider receipt are retained with the stage evidence.

Claude Cloud's existing visible fallback remains intentional. Its separate
automatic task preparation work consumes the shared execution/fallback fields;
this change adds no Claude task provisioning or account-selection changes.
