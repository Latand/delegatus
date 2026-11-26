# MCP recovery verification

Verified on 2026-11-12 with Bun 1.4.0 and SDK 1.32.0. Base: `c39bd873b1`.
Production code changes are confined to `src/lib/mcp/startup.ts`.

An established stdio client's discovery failed immediately when its Viewer
connection was reset or refused. Discovery now waits through transient
connection failures and gateway outages under one 55-second recovery deadline.
Initial admission, authorization failures and invalid JSON retain their
existing refusal behavior. Every retry revalidates the caller against the
Viewer. No tool call, mutation, receipt or authority is cached by this change.

The regression starts a disposable server process on loopback port 0, serving
the exported MCP route with the tool service, production bindings, policy and
SQLite receipts. A live SDK client calls tools, loses an in-flight read and
mutation when that process is killed, discovers again during the outage, then
calls a tool on the replacement process at the same endpoint. It also checks
revocation after recovery. Claude and Codex each exercise their generated HTTP
definition, the stdio launcher and the direct source entry. Launcher cases use
the production bundle when it has been built in the export. The Claude
launcher outage lasts 44 seconds; the final case completed in 47.3 seconds,
including setup and final revocation checks. This is recovery evidence, with
no throughput claim.

The stdio read reports a retryable error; the mutation reports `outcome_unknown`
and `original-key-lookup`. HTTP callers receive transport errors and keep the
same SDK client usable for the next request. The forwarding regression also
checks that an uncertain write replays its receipt without a second effect and
that revoked authority cannot disclose that saved result.

## Commands and isolation

Every test and MCP build below ran in a scratch export. `GATE` denotes the
stage-provided `scripts/gate-slot.sh`; each invocation used a fresh `RUN_LOG`
under the stage's scratch directory. Logs are retained with the stage evidence.
The command prefix was:

```sh
HOME="$CHECKS/home" XDG_CONFIG_HOME="$CHECKS/config" \
LLV_STATE_DIR="$CHECKS/state" TMPDIR="$CHECKS/tmp" \
LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1 LLV_GATE_RUNNER=off \
LLV_OWNED_RUN_TIMEOUT_MS=240000 \
bash "$GATE" --record "$RUN_LOG"
```

The launcher suite used `LLV_OWNED_RUN_TIMEOUT_MS=360000`. The test runner
additionally provides fresh test isolation; spawned servers and clients get
private HOME, configuration, state and temporary directories. No test uses
the serving installation or its stable port. Each recorded check was awaited
through its terminal exit and owned cleanup.

These command abbreviations expand exactly as follows:

| Command | Expansion |
| --- | --- |
| R60 | `bun test --timeout=60000 src/lib/mcp/relaunch.integration.test.ts` |
| R70 | `bun test --timeout=70000 src/lib/mcp/relaunch.integration.test.ts` |
| S | `bun test --timeout=60000 src/lib/mcp/startup.test.ts` |
| F | `bun test --timeout=60000 src/lib/mcp/largeReads.test.ts` |
| B | `bun run build:mcp` |
| L | `bun test --timeout=60000 bin/mcp-server.test.ts` |

## Every test and build invocation

Counts are pass / fail / skip, followed by assertion count. Earlier iterations
are retained so their failures remain visible; the final results identify the
source and artifacts used at handover.

| Run log | Inputs | Command | Exit | Counts or artifacts |
| --- | --- | --- | --- | --- |
| `relaunch-base.log` | Base, initial test iteration | R60 | 1 | 0 / 6 / 0; 34 assertions |
| `relaunch-head-1.log` | Initial fix and test iteration | R60 | 1 | 4 / 2 / 0; 56 assertions |
| `startup-head.log` | Initial recovery cases | S | 0 | 23 / 0 / 0; 327 assertions |
| `relaunch-base-final.log` | Base, corrected test expectations | R60 | 1 | 2 / 4 / 0; 36 assertions |
| `relaunch-head-final.log` | Source entries, 44-second outage | R70 | 0 | 6 / 0 / 0; 56 assertions |
| `largeReads-head.log` | Fix, forwarding compatibility | F | 1 | 16 / 1 / 0; 493 assertions |
| `largeReads-base.log` | Base, same compatibility check | F | 1 | 16 / 1 / 0; 493 assertions |
| `build-mcp-head.log` | Initial production bundle | B | 0 | One bundle, 11,770,935 bytes |
| `relaunch-bundled-final.log` | Bundle plus interrupted mutation cases | R70 | 0 | 6 / 0 / 0; 70 assertions |
| `startup-head-final.log` | Final source and guard tests | S | 0 | 25 / 0 / 0; 338 assertions |
| `build-mcp-base.log` | Base production bundle | B | 0 | One bundle, 11,769,721 bytes |
| `relaunch-bundled-base-final.log` | Base bundle, final regression tests | R70 | 1 | 2 / 4 / 0; 50 assertions |
| `build-mcp-final.log` | Final production bundle | B | 0 | One bundle, 11,771,093 bytes |
| `relaunch-final.log` | Final source, bundle and regression tests | R70 | 0 | 6 / 0 / 0; 70 assertions |
| `launcher-final.log` | Final launcher compatibility | L | 0 | 38 / 0 / 1; 225 assertions |

The first two runs exposed an incorrect HTTP revocation assertion in the test:
the SDK exposes the HTTP status as `error.code`, rather than including it in
the message. Correcting that assertion leaves both HTTP cases passing on the
base, while all four stdio discovery cases fail there. Those four cases pass
on the final fix, including the production bundle.

The forwarding suite's sole failure is its existing eager-import graph
assertion: the stdio graph reaches `src/lib/pipelines/store.ts`. Base and fix
have the same failing assertion and counts. Its other sixteen checks pass on
both. This change leaves that separate import graph issue for its owner.
The launcher suite's native Codex capability-forwarding case is conditionally
skipped; the SDK attachment tests above run for both engines without a provider
login or a model request.

## Other checks

`bun node_modules/eslint/bin/eslint.js src/lib/mcp/startup.ts
src/lib/mcp/startup.test.ts src/lib/mcp/relaunch.integration.test.ts
src/lib/mcp/relaunchServer.fixture.ts` exited 0: four files, zero warnings or
errors. `git diff --check` exited 0 with zero whitespace errors.

The full changed-file privacy scan also exited 0 with zero findings:

```sh
LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE=scripts/privacy-known-value-fingerprints.json \
LLV_PRIVACY_OCR_LANGUAGES=eng+ukr bun scripts/privacy-publication-gate.ts \
  --require-known-values --base origin/main
```

The repository's normal commit hook and publication privacy results are
recorded in the stage handover. The pipeline publisher owns the PR and its
pre-push checks. This stage performs no deployment.
