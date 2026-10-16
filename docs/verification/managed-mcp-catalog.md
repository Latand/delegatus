# Managed update MCP catalog gate

## Step one: probe paths before implementation

Recorded on 2026-10-16 against main `917189ae562def76980341620987479ab2813cfc`, before source changes.

| Path | Process and generation that checks health | Source on that revision |
| --- | --- | --- |
| Managed Docker image update | The serving runtime host runs its installed adapter executable. That adapter imports the installed generation's probe, starts the staged candidate MCP runtime through the stable launcher, and checks it before promotion. The prober and candidate can therefore ship different catalogs. | `src/runtime-host/main.ts:173`, `src/runtime-host/main.ts:271`; `src/runtime-host/deploymentAdapter.ts:496`, `src/runtime-host/deploymentAdapter.ts:535`; `src/runtime-host/deployment.ts:356`; `scripts/runtime-host-viewer-adapter.ts:73`, `scripts/runtime-host-viewer-adapter.ts:847` |
| Managed post-promotion and bootstrap reconciliation | The same installed adapter calls the same probe against the promoted endpoint or newly staged runtime. The full catalog comparison remains the adapter generation's comparison. | `scripts/runtime-host-viewer-adapter.ts:834`, `scripts/runtime-host-viewer-adapter.ts:1365`, `scripts/runtime-host-viewer-adapter.ts:1525` |
| External checkout deploy | The invoked Python procedure publishes the prepared target, restarts the named service, then checks HTTP, the runtime socket and an MCP `agent_activity` call. Its MCP child runs the existing checkout's launcher from the private plan; that launcher selects the published runtime. The Python verifier never calls `probeMcpRuntime` or compares full catalogs. | `scripts/deploy-checkout.py:114`, `scripts/deploy-checkout.py:580`, `scripts/deploy-checkout.py:640`, `scripts/deploy-checkout.py:746`, `scripts/deploy-checkout.py:1292`, `scripts/deploy-checkout.py:1312`; `bin/mcp-server.mjs:138` |
| In-app checkout self-update | The installed Viewer's step runner installs and builds the target in a release directory, checks its build id, then publishes it. The launcher performs process/socket and page/chunk health checks during handover. This path does not run the managed adapter's MCP catalog gate. | `src/lib/selfUpdate/steps.ts:334`, `src/lib/selfUpdate/steps.ts:338`, `src/lib/selfUpdate/steps.ts:343`; `bin/launcher-relaunch.mjs:95`, `bin/launcher-relaunch.mjs:134`, `bin/launcher-relaunch.mjs:206` |
| In-app package self-update | The installed Viewer installs the pinned published package, validates its runtime artifacts and publishes the package pointer. It uses the same launcher handover checks, without the managed MCP catalog comparison. | `src/lib/selfUpdate/package.ts:95`, `src/lib/selfUpdate/package.ts:98`, `src/lib/selfUpdate/package.ts:100`; `bin/launcher-relaunch.mjs:206` |

The failing comparison imports `MCP_TOOL_NAMES` from the probe generation in `src/runtime-host/mcpRuntimeProbe.ts:7`, assigns it at line 21 and compares it with the candidate's `tools/list` at line 229. This explains why deliberately removing a tool blocks a managed update while a checkout deploy can succeed.

## Shared surface inventory and open work

The catalog is declared in `src/lib/mcp/server.ts`; ordinary stdio and authenticated HTTP clients use `createViewerMcpServer`. The runtime-host-admitted probe uses `createViewerMcpHealthProbeServer`, which adds the deprecated registration for older installed probers. Consumers include protocol clients, server catalog tests, binding and policy maps, receipt validation and the managed health probe. The compatibility registration stays outside the active catalog so those maps, policies and agent guidance cannot acquire a new action.

The registry-store, idle-worker and decision-answer delivery branches had no committed delta from this main revision when inspected. The MCP-process branch changes `server.ts`, `entry.ts`, `build-mcp.ts` and launcher/transport files. Its actual server diff was inspected: it adds optional registration selection, a lazy protocol validator and forwarding changes. This fix uses a separate health-probe server factory for the deprecated registration and leaves that branch's build, entry and launcher changes intact.

## Bridge removal

- [ ] Keep the deprecated protocol entry through the next release. Remove it only after managed updates enforce a hop through a release with the candidate-catalog probe for every supported pre-fix installation, or the supported upgrade floor explicitly excludes those installations. A later version number alone does not satisfy this condition: an unchanged old prober can skip releases.

The entry only returns `tool_retired`, with `retryable: false` and the `publish_prototype_review` decision-form route. It never invokes the tool service or stores reply drafts. It stays outside `MCP_TOOL_NAMES`, binding and receipt maps, mandates and prompt construction. The deleted draft HTTP route stays deleted.

The old/new pairing test freezes the actual probe and catalog from `e37dc8d04e9b75d00643c8939ee3a08880217447`, immediately before the removal. Only import locations and the inlined catalog change in that fixture. It probes the current server as a child process and runs a negative control with the bridge excluded.

## Acceptance mapping

| Part | Change | Regression and evidence |
| --- | --- | --- |
| A | The candidate advertises version 1 of `delegatus/tool-catalog` in its MCP initialize capabilities. The probe compares that declaration with the candidate's registrations, plus `deployment_status` and `board_snapshot`. The probe imports no active server catalog. Pre-declaration releases use their own `tools/list` for rollback and bootstrap; a present malformed declaration fails. | `src/runtime-host/mcpRuntimeProbe.test.ts`: deliberate removal, candidate-only declaration missing from registration, stable contract removal, malformed catalogs and legacy rollback/bootstrap. `src/runtime-host/mcpRuntimeCompatibility.test.ts` also checks the production server's declaration. |
| B | The runtime-host-admitted health-probe server registers `suggest_replies` for older installed probers and returns a refusal pointing to `publish_prototype_review`. Ordinary stdio and HTTP clients do not discover it. Active bindings, receipts and prompt catalogs stay separate from that entry. The follow-up above names the removal condition. | `src/runtime-host/mcpRuntimeCompatibility.test.ts`: ordinary stdio absence, unchanged old probe against the new candidate, missing-bridge negative control, empty and hostile call arguments, and zero service calls. `src/lib/mcp/http.test.ts` checks ordinary HTTP absence; `src/runtime-host/mcpRuntimeProbe.test.ts` checks the admitted probe path. The bootstrap and successor tests in `scripts/runtime-host-viewer-adapter.test.ts` check the active catalog plus the bridge. Existing mandate and issue-report guidance tests remain part of verification. |
| C | Stored historical failures and new catalog failures get localized explanations. The retry button has visible guidance and a matching title: the same incompatible image cannot be repaired by retrying, while a temporary failure may clear. | `src/components/selfUpdate/SelfUpdateView.dom.test.tsx`: four catalog causes and a temporary failure, both locales, plus retry interaction. `src/components/kanban/kanbanBoard.browser.test.tsx`, case `managed MCP catalog failure`, captures the real dialog in both locales and themes at phone, middle and desktop widths. |

The machine-readable verification record is `evidence/managed-mcp-catalog.json`. The browser case writes reproducible frames and readings under `.artifacts/managed-mcp-catalog/`. This change claims no performance improvement.

## Reproducing checks in a stage scratch export

Run each explicit test path through `bash scripts/gate-slot.sh bun test <path>`. This stage used the installed gate wrapper named by its launch instructions. All commands ran in source exports, with private HOME, config, state and temporary directories. For short Unix socket paths, a held directory descriptor exposed the same scratch directory through `/proc/<runner-pid>/fd/<descriptor>`; every created file remained in that owned scratch directory.

On a scratch root outside the standard OS temp prefixes, add a preload after the project's own `test-preload.ts`. That preload claims a narrower process temp directory, so HOME, XDG_CONFIG_HOME and LLV_STATE_DIR must then be placed inside that directory too. Otherwise the state guard classifies the sibling config as operator state. The extra preload used the following layout, importing the export's `test-preload.ts` first:

```ts
import fs from "node:fs";
import path from "node:path";
await import(path.resolve("test-preload.ts"));
const root = process.env.TMPDIR!;
for (const [key, name] of Object.entries({
  HOME: "home", XDG_CONFIG_HOME: "config", LLV_STATE_DIR: "state",
})) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  process.env[key] = directory;
}
```

Pass it with `bun test --preload <private-preload> <explicit-test-paths>`. The first attempts with sibling config directories produced the same six launcher/adapter timeouts on main and head; the final runs use the nested layout. Neither production code nor the committed test preload changes for this adaptation.

The Viewer runtime verifier constructs its own sibling config directory. In the private export only, its copied `sandboxEnvironment` used `TMPDIR: sandbox` instead of `TMPDIR: path.join(sandbox, "tmp")`. This keeps every sandbox directory under its declared temp root, with no owner token supplied. The build, loaded production modules, server startup and HTTP probes use the candidate's unchanged artifacts. The committed verifier remains unchanged; the evidence distinguishes this adapted run from the initial refusal.

## Verification result

The final selection passed 500 tests, with two existing opt-in Docker cases skipped. The new cases failed on main: ten catalog cases (A), two compatibility cases (B), and ten panel cases (C). The old-prober pairing passed with the bridge and failed with exactly `MCP runtime is missing tools: suggest_replies` when the bridge was excluded.

TypeScript, changed-file ESLint, the production build, MCP answer-size budgets, Linux backend verification and runtime negative controls passed. The Viewer loaded all 25 compiled modules and served HTTP 200 with the private temp-root adaptation above. Its compiled Codex socket probe passed. The runtime host completed succession and answered 27/27 listener and socket observations over 15 seconds under Bun 1.4.0. The browser driver passed both captures; all 60 head frames and eight main frames were visually inspected. The JSON record carries commands, source checksums, frame checksums and the measured results.

`origin/main` was fetched and merged without a rebase; it remained at the recorded base. Required hosted checks run after Delegatus publishes the branch. The PR mapping is the A–C table above; the retained compatibility entry's removal remains the tracked follow-up in this document.
