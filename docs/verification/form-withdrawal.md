# Form withdrawal verification

Read on 2026-11-12 07:21 UTC. Baseline: `34b74135`. The final fetch found two unrelated changes on main (`c39bd873b1` and `f9571ba01c`, composer and stage-panel tests); none of this change's paths moved. The implementation, tests and this report are committed together. No performance gain is claimed.

## Procedure

Every test below ran from a scratch export. Each file ran as a separate Bun process with isolated `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR`; the control URL pointed to a closed loopback port. The SDK tests served the exported MCP route on port 0, using the real SDK client, tool service, schema, policy and receipts. Only fixture-owned handles were closed. The first standalone iterations reused one private stage sandbox; campaigns and the final baseline gave each file fresh directories.

All test and lint commands used the pinned `scripts/gate-slot.sh` runner. Standalone runs used `rtk proxy bash "$GATE" --record "$TMPDIR/<run>.log" "$ISOLATE" <command>`. Campaigns used the same recorder around a sequential script; every listed command invoked `$ISOLATE` separately. Each recording had exactly one `wait_for_check` call, and every run reached a terminal command receipt. `$ISOLATE` is the scratch script that sets the four private directories and enters the export. The original logs are retained in the lane's private evidence under `checks/`; this public record omits machine paths and raw logs.

## Focused campaigns

Each command is `bun test --timeout=60000 <file>`. Cells show **exit; pass/fail; assertions**. Campaign 1 ended 1 (two red files), campaign 2 ended 0, and campaign 3 ended 0 before the workspace follow-up below.

| File / command argument | Campaign 1 | Campaign 2 | Final campaign 3 |
|---|---|---|---|
| `src/lib/mcp/formWithdrawal.test.ts` | 0; 3/0; 32 | 0; 6/0; 38 | 0; 6/0; 46 |
| `src/components/decisions/DecisionColumn.dom.test.tsx` | 0; 52/0; 398 | 0; 52/0; 398 | 0; 52/0; 398 |
| `src/lib/prototypeReview/answerDelivery.test.ts` | 0; 74/0; 233 | 0; 78/0; 244 | 0; 81/0; 250 |
| `src/lib/mcp/dismissAttention.test.ts` | 1; 26/1; 161 | 0; 27/0; 168 | 0; 27/0; 168 |
| `src/lib/attention/dismissals.test.ts` | 0; 22/0; 130 | 0; 22/0; 130 | 0; 22/0; 130 |
| `src/lib/attention/needsYouRead.test.ts` | 0; 20/0; 89 | 0; 20/0; 89 | 0; 20/0; 89 |
| `src/lib/prototypeReview/model.test.ts` | 0; 9/0; 28 | 0; 9/0; 28 | 0; 9/0; 28 |
| `src/lib/prototypeReview/seatDecisions.test.ts` | 0; 20/0; 142 | 0; 20/0; 142 | 0; 20/0; 142 |
| `src/lib/prototypeReview/deliveryWorker.test.ts` | 1; 13/1; 134 | 0; 14/0; 136 | 0; 14/0; 136 |
| `src/lib/prototypeReview/answerDelivery.integration.test.ts` | 0; 7/0; 57 | 0; 7/0; 57 | 0; 7/0; 57 |
| `src/lib/i18n/i18n.test.ts` | 0; 25/0; 15439 | 0; 25/0; 15439 | 0; 25/0; 15439 |

Core campaign total: **283 pass, 0 fail across 11 files**. The later workspace follow-up replaces the six-case MCP result with eight passing cases, giving **285 pass, 0 fail across the final 11-file selection**.

Campaign 1 found an existing full-id expectation in the escalation test (also red on base), plus a worker restart test whose 2030 clock now correctly expired every answer. The escalation call now requests full ids; the worker test uses a frozen clock inside the delivery age limit. The final SDK fixture reproduces five open forms plus an undelivered answer: six rows and six withdrawal targets. Pending revocation, project movement and removal write no mark. The final delivery file also covers receipts arriving across the cutoff, dispatch races, restart persistence and strict replica round-trips.

## Standalone iterations and pinned-base comparisons

Commands here are also `bun test --timeout=60000 <file>`. These are historical runs, preceding the final campaign unless marked final baseline. Base exports contain the pinned production source and the acceptance tests named by the row.

| Run | File / command argument | Exit | Pass/fail | Assertions |
|---|---|---:|---:|---:|
| `forms-mcp-1` | `src/lib/mcp/formWithdrawal.test.ts` | 1 | 0/3 | 6 |
| `forms-mcp-2` | `src/lib/mcp/formWithdrawal.test.ts` | 1 | 2/1 | 12 |
| `forms-mcp-3` | `src/lib/mcp/formWithdrawal.test.ts` | 0 | 3/0 | 32 |
| `forms-ui-1` | `src/components/decisions/DecisionColumn.dom.test.tsx` | 0 | 52/0 | 398 |
| `forms-delivery-1` | `src/lib/prototypeReview/answerDelivery.test.ts` | 1 | 73/1 | 224 |
| `forms-delivery-2` | `src/lib/prototypeReview/answerDelivery.test.ts` | 1 | 72/2 | 223 |
| `forms-delivery-3` | `src/lib/prototypeReview/answerDelivery.test.ts` | 1 | 73/1 | 230 |
| `forms-base-delivery` | `src/lib/prototypeReview/answerDelivery.test.ts` | 1 | 69/5 | 219 |
| `forms-base-mcp` | `src/lib/mcp/formWithdrawal.test.ts` | 1 | 0/3 | 4 |
| `forms-base-ui` | `src/components/decisions/DecisionColumn.dom.test.tsx` | 1 | 45/7 | 316 |
| `forms-base-dismiss` | `src/lib/mcp/dismissAttention.test.ts` | 1 | 26/1 | 161 |
| `forms-base-worker` | `src/lib/prototypeReview/deliveryWorker.test.ts` | 0 | 14/0 | 136 |
| Core baseline | `src/lib/mcp/formWithdrawal.test.ts` | 1 | 0/6 | 4 |
| Core baseline | `src/components/decisions/DecisionColumn.dom.test.tsx` | 1 | 45/7 | 316 |
| Core baseline | `src/lib/prototypeReview/answerDelivery.test.ts` | 1 | 71/10 | 235 |

The core baseline campaign ended 1: the three acceptance files from that run are red on the pinned source. The taskless target, count and retirement tests pass on the final implementation. Earlier delivery iterations also exposed a restarted child reading a different task root; the fixture now pins the writer's task root. An existing strict empty-stderr assertion failed on both source revisions because SQLite emitted a named timing diagnostic; it now permits that diagnostic while still checking the child exit and all other stderr.

## Browser and tooling commands

Browser runs used `CHROME_BIN`, `LLV_KANBAN_BROWSER_TEST=1`, a private Chrome socket directory and `LLV_OWNED_RUN_TIMEOUT_MS=900000`. The browser executable's version probe returned exit 0. The dependency probe found no missing shared libraries (the filter exited 1 because there were no matches).

| Run | Command | Exit | Counts |
|---|---|---:|---|
| `forms-browser-probe` | Browser probe command below | 0 | 1 launch, 1 rendered page, 0 failures |
| `forms-browser-1` | `bun test --timeout=300000 src/components/kanban/kanbanBoard.browser.test.tsx -t "waiting forms can be withdrawn"` | 0 | 1 pass, 0 fail, 306 filtered, 32 assertions |
| `forms-browser-2` | `bun test --timeout=300000 src/components/kanban/kanbanBoard.browser.test.tsx -t "saved decision delivery"` | 1 | 1 pass, 1 fail, 305 filtered, 92 assertions |
| `forms-browser-3` | `bun test --timeout=300000 src/components/kanban/kanbanBoard.browser.test.tsx -t "saved decision delivery"` | 1 | 1 pass, 1 fail, 305 filtered, 114 assertions |
| `forms-browser-4` | `bun test --timeout=300000 src/components/kanban/kanbanBoard.browser.test.tsx -t "saved decision delivery"` | 0 | 2 pass, 0 fail, 305 filtered, 216 assertions |
| `forms-lint-1` | ESLint command below | 0 | 21 files; 0 errors, 13 warnings on existing unused bindings |

The second browser run exposed a test assumption about a desktop strip that is hidden while its column is visible. The third exposed an assertion that ran before the shared board poll acknowledged delivery. The final browser run checks the phone strip, the desktop tab and the acknowledged badge after that poll. Both cases pass across 390 px and 1440 px, English and Ukrainian, light and dark: 16 scenario combinations. Withdrawal preserves three forms through refusal, then clears all three; saved answers retain their original content and disappear after confirmed retry delivery.

The exact lint file selection is the TypeScript/TSX paths in this change, including the new MCP file. No repository-wide typecheck, build or full test suite ran in this stage; those belong to the pipeline's publication gate. `git diff --check` returned 0 during implementation and before commit.

Rendered records: `evidence/form-withdrawal/panel.json` and `evidence/answer-delivery/panel.json`. Their screenshots remain in the lane's retained evidence. The builder opened the refusal and cleared frames at phone and desktop sizes. The original task's three legacy rows are clearable by the procedure in `docs/design/form-withdrawal.md#clearing-the-three-reported-legacy-rows`; this stage did not change live state.

## Exact tooling invocations

The browser probe ran under the same recorded wrapper:

```bash
bun -e 'import { chromium } from "playwright-core"; import { ownedBrowserSocketEnvironment } from "./src/components/kanban/issue1695BrowserHarness"; const sockets=ownedBrowserSocketEnvironment(); const browser=await chromium.launch({executablePath:process.env.CHROME_BIN,headless:true,args:["--no-sandbox"],env:sockets.env}); try { const page=await browser.newPage(); await page.setContent("<p>Browser support</p>"); if(await page.locator("p").textContent()!=="Browser support")throw new Error("render failed"); console.log("1 browser launch, 1 rendered page, 0 failures"); } finally {await browser.close();sockets.close();}'
```

ESLint used this exact file selection:

```bash
bun node_modules/eslint/bin/eslint.js \
  src/components/decisions/DecisionCard.tsx \
  src/components/decisions/DecisionColumn.dom.test.tsx \
  src/components/decisions/DecisionColumn.tsx \
  src/components/decisions/useOperatorDecisions.ts \
  src/components/kanban/issue1695Evidence.fixture.tsx \
  src/components/kanban/kanbanBoard.browser.test.tsx \
  src/lib/attention/dismissalTypes.ts \
  src/lib/attention/dismissals.ts \
  src/lib/attention/needsYouRead.ts \
  src/lib/i18n/en.ts \
  src/lib/i18n/uk.ts \
  src/lib/mcp/bindings.ts \
  src/lib/mcp/dismissAttention.test.ts \
  src/lib/mcp/formWithdrawal.test.ts \
  src/lib/mcp/server.ts \
  src/lib/prototypeReview/answerDelivery.test.ts \
  src/lib/prototypeReview/decision.ts \
  src/lib/prototypeReview/deliveryWorker.test.ts \
  src/lib/prototypeReview/model.ts \
  src/lib/prototypeReview/read.ts \
  src/lib/prototypeReview/types.ts
```

The browser installation checks were `"$CHROME_BIN" --version` (exit 0; one version) and `ldd "$CHROME_BIN" | rg "not found"` (exit 1; zero missing-library matches).

## Workspace follow-up and final source checks

Final permission-path review found that a taskless operator request also needs a project hint for workspace admission. The UI now supplies it. The operator route checks the stored round's project and current membership before writing, and refuses capability-bearing agents. Scoped-member success, forged ownership, pending revocation and restoration are covered through the exported route.

All rows below used the same recorded runner and fresh per-file isolation. Test commands remain `bun test --timeout=60000 <file>`.

| Run | Command / file | Exit | Pass/fail | Assertions |
|---|---|---:|---:|---:|
| `forms-workspace-1` | `src/lib/mcp/formWithdrawal.test.ts` | 1 | 7/1 | 53 |
| `forms-workspace-1` | `src/components/decisions/DecisionColumn.dom.test.tsx` | 0 | 52/0 | 398 |
| `forms-workspace-1` | `src/lib/attention/dismissals.test.ts` | 0 | 22/0 | 130 |
| `forms-final-checks` | `src/lib/mcp/formWithdrawal.test.ts` | 0 | 8/0 | 55 |
| `forms-final-checks` | `src/components/decisions/DecisionColumn.dom.test.tsx` | 0 | 52/0 | 398 |
| `forms-final-checks` | `src/lib/attention/dismissals.test.ts` | 0 | 22/0 | 130 |
| `forms-final-checks` | Final ESLint invocation | 0 | 22 files; 0 errors, 13 existing warnings | — |
| `forms-final-checks` | `bun test --timeout=300000 src/components/kanban/kanbanBoard.browser.test.tsx -t "saved decision delivery"` | 0 | 2/0 | 216 |

The workspace run's one failure came from a fixture using a registry after its temporary directory was deleted. Each test now owns and closes its registry. The final five-command run ended 0: 8 MCP/route cases, 52 Decisions DOM cases, 22 dismissal cases, ESLint on 22 files, and both browser cases. The other eight focused files retain their passing campaign-3 results because their inputs did not change. The final browser command uses `-t "saved decision delivery"`; its output also reports 305 filtered cases. No unfiltered browser suite ran.

The final ESLint selection is the exact 21-file invocation above plus `src/app/api/attention/dismissals/route.ts`.

## Publication checks

| Run | Command | Exit | Counts |
|---|---|---:|---|
| `forms-privacy-1` | `bash "$TMPDIR/forms-privacy.sh"` | 127 | 0 checker executions; the wrapper was absent after a preparation error |
| `forms-privacy-2` | `bun scripts/privacy-publication-gate.ts --require-known-values --paths <the 25 changed paths before the operator-route follow-up>` | 0 | 25 selected files; `PRIVACY GATE: PASS` |
| `forms-privacy-auth` | `bun scripts/privacy-publication-gate.ts --require-known-values --paths src/app/api/attention/dismissals/route.ts src/components/decisions/useOperatorDecisions.ts src/components/decisions/DecisionColumn.dom.test.tsx src/lib/mcp/formWithdrawal.test.ts` | 0 | 4 selected files; `PRIVACY GATE: PASS` |

Privacy commands set `LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE=scripts/privacy-known-value-fingerprints.json` and `LLV_PRIVACY_OCR_LANGUAGES=eng+ukr`. The full-file scan's 25-path selection is every changed path except `src/app/api/attention/dismissals/route.ts`, which the follow-up scan adds. A final small scan renews the fixture, documentation, evidence JSON and outgoing message payloads after this follow-up. The commit's own hook runs staged whitespace and changed-file ESLint; its actual exit accompanies the stage handover and retained log.

The first `forms-privacy-final-text` invocation scanned seven files: both documents, both evidence JSON files, the final MCP fixture, the temporary commit message and the stage-report JSON. It exited 1 with one `email_address` finding because a temporary prose file does not get the commit-trailer exemption. The required tool attribution remains in the commit. The renewed text scan excludes that temporary message; commit attribution is checked in commit context by `--check-commits` after the local commit.

`forms-privacy-final-text-2` repeated `bun scripts/privacy-publication-gate.ts --require-known-values --paths docs/design/form-withdrawal.md docs/verification/form-withdrawal.md evidence/answer-delivery/panel.json evidence/form-withdrawal/panel.json src/lib/mcp/formWithdrawal.test.ts "$TMPDIR/forms-stage-report.json"`: exit 0, six selected files, `PRIVACY GATE: PASS`. The commit-context check and the actual commit-hook result accompany the final stage handover.
