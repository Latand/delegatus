# GitHub Copilot engine — build plan for slices 2, 3 and 4

Written for a builder who is new to this repository. Read it top to bottom once
before touching code. Every path and line anchor below is on the slice-1 PR head
**`06eca32d`** (PR #2032, branch `pipeline/github-copilot-as-a-third-engine-design-60205ef9`).
Slice 1 merges before you start, so anchors on `main` will drift by a few lines. Find
each site by the quoted symbol and comment, not by the line number alone.

Source documents:

- `docs/design/copilot-engine.md`, the engine design. §3 covers each concern, §4 is
  the slice plan, and §5 lists the risks. This plan refines its §4 "Slice 2/3/4" bullets.
- The body of PR #2032, especially "Left for later slices". Every item there is
  assigned to a slice below.
- The comments on PR #2032 at `issuecomment-5785444267` (real-login facts) and
  `issuecomment-5785547942` (the Viewer path against a real login).
- `AGENTS.md` at the repo root. Its rules on state ownership, tests and publication
  are not optional. The ones that bite on this work are repeated in §6.

---

## 0. The recommendation (read this first)

- **Slices 2 and 3 ship as two PRs. Slice 3 (limits) goes first.** The data it needs
  is already known from a real Free account (§1.3). It is small, touches a separate
  set of files, and pays off immediately: the footer shows the Free allowance, and
  automatic selection stops treating Copilot as "unavailable". Slice 2 (sign-in, model
  catalogue, runtime switching) comes second. It depends on two captures from the real
  account (§2, C1 and C2) that should run while slice 3 is in review.
- **Slice 4 waits** until both are merged and deployed and Copilot has done real work
  through the deployed Viewer, including the Docker keyring check (§2, C6). Slice 4 needs:
  - slice 2's auth state, because pipeline engine readiness asks "is anybody signed in";
  - slice 3's capacity observations, for automatic stage account selection;
  - an audit of every automated sender (§5.4). A Copilot turn cannot be steered, so a
    seat tick or pipeline relay sent with the default `interrupt-active` policy would
    cancel the agent's running turn.

---

## 1. Facts established since the design

### 1.1 The CLI (1.0.87, re-verified; see design §1)

- ACP runs over stdio with `copilot --acp`. `--port` is still undocumented. Do not use it.
- `--acp` **refuses `--session-id`**. The session id comes from `session/new`.
  `session/new` also ignores a `sessionId` passed in params or `_meta`.
- ACP `session/new` **rejects stdio MCP servers**. The CLI logs `Rejecting non-http/sse
  MCP server "<name>" from client`. Stdio servers attach at process start with
  `--additional-mcp-config @<file>`, as `{"mcpServers":{"<name>":{"type":"local",
  "command":…,"args":[…],"env":{…},"tools":["*"]}}}`. The model then sees each tool as
  `<server>-<tool>`, for example `viewer-stage_report`.
- **Model and effort are fixed per process** by `--model` and `--reasoning-effort`.
  The CLI does not persist effort: a process started without the flag loads the same
  session at `medium`. Every adopt must pass both flags again.
- **A second `session/prompt` during a running turn silently aborts that turn.** The
  transcript gets `abort {reason:"user_initiated"}` and the new prompt runs. The host
  never lets this happen: it refuses a second send as `stale-turn`.
- **A cancelled `session/prompt` answers `stopReason:"end_turn"`**, not `cancelled`.
  The host remembers that it cancelled.
- `session/load` replays the whole history as `session/update` notifications before
  answering. ACP has no sequence cursor.
- Tool names change between CLI versions (1.0.86 had `grep`, 1.0.87 has `rg`). Read tool
  names from records; never hard-code them.

### 1.2 Login on the real account (operator's Copilot Free account)

- `COPILOT_HOME=<home> copilot login --device-code` stores the **token in the desktop
  Secret Service keyring**, as an item with service `copilot-cli` keyed by the GitHub
  username. The managed home's **`config.json` holds no token**, only who is signed in.
  Its shape (key names only):
  `{ firstLaunchAt: string, lastLoggedInUser: { host: string, login: string },
     loggedInUsers: [ { host, login } ] }`.
  The file has a leading `//` comment line, so strip `^\s*//.*$` before `JSON.parse`.
- Two homes signed in as **different** GitHub users get separate keyring items. Two
  homes signed in as the **same** user share one token.
- The CLI finds the keyring **without `DBUS_SESSION_BUS_ADDRESS`**, through the default
  socket `/run/user/<uid>/bus`. It does not use the `gh` token.
- **Bus unreachable → ACP `session/new` fails with `Authentication required`**, before
  any prompt, so no request is billed. This also gives a free auth probe (§4.1).
- After a reboot without a desktop login, the keyring is locked and every launch fails
  with `Authentication required`.
- **Not observed yet:** whether the Docker install's nsenter shim reaches that bus.
  Capture C6 checks this after deploy.

### 1.3 What a real transcript contains that BYOK never produced

Census of the real account's `session-state/*/events.jsonl` (types and key names only):

| Record type | Keys that matter | Use |
|---|---|---|
| `model.model_call_success` | `quotaSnapshots`, `copilotUsage`, `responseUsage`, `reasoningEffort`, **`requestMessages`** (the full prompt), `responseChunk` | **The plan-limit signal (slice 3).** Also huge and private: never render or index it. |
| `model.model_call_started` / `model.turn_started` / `model.turn_ended` | `model`, `modelInfo` (a catalogue record, below) | Per-model effort ladder (slice 2); render nothing |
| `model.message`, `model.response`, `model.messages_snapshot`, `model.captured_assignment_context` | full message bodies | Render nothing, index nothing |
| `session.auto_mode_resolved` | `chosenModel`, `candidateModels`, `availableModels`, `routingMethod` ("auto_v2"), `fallback` | The model `auto` actually ran (slice 2) |
| `session.usage_checkpoint` | `totalPremiumRequests`, `totalNanoAiu`, cache state | Per-session usage |
| `session.model_change` | `newModel` (`"auto"` at startup), `previousModel`, `reasoningEffort`, `source` ("startup") | Already read by the scanner |
| `session.start` | **no `selectedModel`** on a real `auto` launch | The model comes from `session.model_change` / `auto_mode_resolved` |

`quotaSnapshots` on `model.model_call_success` (observed on Free):

```
quotaSnapshots: {
  chat:                 { isUnlimitedEntitlement: false, entitlementRequests: 200,  usedRequests: 0,
                          usageAllowedWithExhaustedQuota: false, overage: 0,
                          overageAllowedWithExhaustedQuota: false,
                          remainingPercentage: 99.8, resetDate: "2026-10-01T00:00:00Z" },
  completions:          { …same keys…, entitlementRequests: 2000, remainingPercentage: 100 },
  premium_interactions: { …same keys…, entitlementRequests: 0,    remainingPercentage: 0 }
}
```

- `usedRequests` can read 0 while `remainingPercentage` is 99.8. Compute the used
  percentage from `remainingPercentage`, never from `usedRequests`.
- `resetDate` is 00:00 UTC on the 1st of the month.

`modelInfo` (a catalogue record, the same shape as GitHub's Copilot `/models` API):
`{ id, name, object, preview, is_chat_default, is_chat_fallback, model_picker_enabled,
model_picker_category, model_picker_price_category, supported_endpoints,
billing: { restricted_to: ["pro","pro_plus","individual_trial","edu","business",…],
token_prices: {…} }, capabilities: { family, type, tokenizer,
limits: { max_context_window_tokens, max_output_tokens, max_prompt_tokens, vision },
supports: { reasoning_effort: ["none","low","medium","high","xhigh"], tool_calls,
streaming, vision, parallel_tool_calls, structured_outputs, adaptive_thinking } } }`.
Only models the session actually called appear. `auto` resolved to `mai-code-1.1-flash`,
and background calls (titles) used `gpt-5.4-nano`, whose `model_picker_enabled` is false.

Spend so far on the operator's Free allowance: about 7 requests, 2 for the login check
and 5 for the real-mode integration test.

---

## 2. Facts that need the real account, and how to capture them safely

The operator is signed in on Copilot Free. The managed home is
`<config>/agent-log-viewer/accounts/copilot/<id>`. `GET /api/accounts/copilot` lists
`id` and `kind`; the home is `<copilotAccountsRoot()>/<id>` (`src/lib/accounts/copilot.ts:56`).

Rules for every capture:

- Run as the operator's uid inside a desktop session, so the keyring is reachable.
  Never set or print `GH_TOKEN`, `GITHUB_TOKEN` or `COPILOT_GITHUB_TOKEN`. Never print
  the environment. Never print `config.json` values: print key names, and replace the
  `login` with `<user>`.
- Start the child with the host's own environment builder,
  `copilotChildEnv(process.env, home)` (`src/lib/runtime/copilotAcpHost.ts:148`), so the
  capture sees what a Viewer launch sees.
- Record the child's PID when you start it and stop only that PID. Never kill by name
  or pattern. Bind stubs to port 0.
- Captured fixtures go into the repo only after scrubbing:
  - replace user names with a placeholder;
  - generate ids at test time (the privacy gate flags UUID literals);
  - drop `requestMessages`, `responseChunk`, `model.message`, `model.response` and
    `model.messages_snapshot` bodies.
  Run `bun scripts/privacy-publication-gate.ts --base $(git merge-base HEAD origin/main)`
  before you push.
- Measure what each capture costs. Read `session.usage_checkpoint.totalPremiumRequests`
  (or the `session.shutdown` totals) before and after, and write the delta into the PR
  body. The Free allowance is small.

| # | Fact | Capture | Cost |
|---|---|---|---|
| C1 | Whether ACP `session/new` on a logged-in account returns a `model` (and effort) config option, and its values | A one-shot Bun script under the repo, not `/tmp` (`@/` aliases do not resolve outside the repo): spawn `copilot --acp --no-auto-update -C <scratch cwd>` with `COPILOT_HOME=<real home>`, call `initialize` and `session/new`, and print `configOptions.map(o => ({id, category, options: o.options.map(x => x.value ?? x.id)}))` and `modes`. Then `session/close` and stop the recorded PID. | Free (no prompt) |
| C2 | Whether `/model` over ACP lists the account's models without billing | Same script. Print the `available_commands_update` entry named `model` (name, description, input hint). Send `session/prompt` with text `/model`, collect `agent_message_chunk` text, and compare `totalPremiumRequests` in that session's `events.jsonl` before and after. | Should be free; verify with the delta |
| C3 | Per-model effort ladders and plan restrictions | Harvest `modelInfo` from existing real transcripts: parse `model.model_call_started` lines only (they are small), and never parse `model.model_call_success` whole. | Free |
| C4 | How a plan-limit exhaustion looks on the wire | Do not burn the allowance to find out. Build slice 3 on `quotaSnapshots` (§1.3). Add logging that records the JSON-RPC `error` of a failed `session/prompt` (`code`, and `message` truncated to 300 chars) together with the last `quotaSnapshots`, so the first natural exhaustion is captured. | None |
| C5 | The output of `copilot login --device-code` (URL line, code line, success line, exit code) | Scratch `COPILOT_HOME` under `/var/tmp`. Run the command and capture stdout and stderr with `[A-Z0-9]{4}-[A-Z0-9]{4}` replaced by `XXXX-XXXX`. After the code line appears, stop the recorded PID. Do not approve. The success line and exit code come from the operator's own run: ask the seat for one real sign-in of a second managed account, captured the same way. | None |
| C6 | After deploy: whether the nsenter shim reaches the host keyring from the container | `docker exec <viewer container> sh -c '<ACP handshake script> '` using `bun-container` (inside the image, plain `bun` is a shim; see `AGENTS.md`). Only `initialize` and `session/new`. The answer is either `sessionId` or `Authentication required`. | Free |
| C7 | Whether a successful `session/new` is ever billed | Run C1 twice and compare the account's `quotaSnapshots.chat.remainingPercentage` before and after, using the newest `model.model_call_success`, which needs one billed turn. Expect no change from `session/new` alone. | 1–2 requests |

---

## 3. Slice 3 — limits (PR 1)

**Outcome:** Copilot accounts show their monthly allowance in the limits footer and in
MCP `account_limits`. Automatic account selection may pick a Copilot account that has
capacity and skips one that is exhausted.

### 3.1 Data shape

Map `quotaSnapshots` onto the existing `EngineLimits` (`src/lib/types.ts:661`) rather
than inventing a new shape:

```ts
// src/lib/limits/copilotQuota.ts  (new)
export interface CopilotQuotaBucket {
  entitlementRequests: number; remainingPercentage: number; resetDate: string | null;
  isUnlimitedEntitlement: boolean; overageAllowedWithExhaustedQuota: boolean;
}
export interface CopilotQuotaSnapshot {
  chat?: CopilotQuotaBucket; completions?: CopilotQuotaBucket; premium_interactions?: CopilotQuotaBucket;
  observedAt: number; // unix seconds, from the record's `timestamp`
}
export function copilotLimitsFromSnapshot(snapshot: CopilotQuotaSnapshot): EngineLimits
```

Mapping rules. Each one needs a unit test.

- The **gating bucket** is the tighter of `chat` and `premium_interactions`, counting
  only buckets with `entitlementRequests > 0` and `!isUnlimitedEntitlement`. On Free,
  `premium_interactions` has entitlement 0 and is ignored, so `chat` gates. `completions`
  never gates, because the CLI does not use completions.
- The gating bucket becomes `weekly` (the one monthly-horizon slot the type has):
  `{ usedPercent: 100 - remainingPercentage, resetsAt: Date.parse(resetDate)/1000,
  windowMinutes: <days in the month ending at resetDate> * 1440, observedAt }`.
  `session: null`. `tiers: []`. `plan: null`: the snapshot names no plan, so do not guess.
- Labels: `windowLabel` (`src/components/rateLimit.ts:49`) would print `30d`/`31d`. Add a
  month label: if `windowMinutes` is between `28*1440` and `31*1440`, return
  `t("limits.month")`. Add `limits.month` to both `src/lib/i18n/en.ts` and `uk.ts`
  (en: "Month", uk: "Місяць").

### 3.2 Reading the snapshot (the hard part is size)

`model.model_call_success` lines carry the whole prompt (`requestMessages`) and can be
megabytes long. Do not `JSON.parse` whole lines.

- `readCopilotTranscriptLimits(sessionStateDir, now)` goes beside
  `readCodexTranscriptLimits` (`src/lib/limits.ts:855`) and follows its contract (it
  returns a `LimitRead`). Take the newest 5 `session-state/*/events.jsonl` by mtime.
  Read each file backwards in 1 MiB chunks, find the last occurrence of
  `"quotaSnapshots":`, extract that object with a brace-depth scanner that respects
  JSON strings and escapes, and parse only that substring. Take the record `timestamp`
  from the same line's suffix after the `quotaSnapshots` object closes; Copilot CLI
  1.0.87 writes it after `data` and `id`, before `parentId`. Bound the total read
  per file (for example 16 MiB). When nothing is found, return
  `{ data: null, reason: "no quotaSnapshots in newest N session files", source: "unavailable" }`.
- The host does not see quota over ACP: `usage_update` is the context window only. The
  transcript is the source. It is fresh after every model call, which is when it matters.

### 3.3 Wiring, in order

1. **Types.** Add `export type QuotaEngine = "claude" | "codex" | "copilot"`. Use it for
   `QuotaObservation.engine` (`src/lib/accounts/migration/quotaPolicy.ts:21`) and
   `DurableQuotaObservation.engine` (`src/lib/accounts/migration/contracts.ts:298`).
   **Do not widen `MigrationEngine`** (`contracts.ts:9`). Account migration stays
   two-engine: a Copilot session cannot move between homes, because `session/load` only
   finds sessions in its own `COPILOT_HOME`, and conversations are never copied between
   accounts. `registry.quotaObservations(engine)` (`src/lib/agent/registry.ts:7935`)
   already takes `AgentEngine`.
2. **Probe.** The quota controller's probe port is `QuotaProbePort`
   (`src/lib/accounts/migration/quotaController.ts:17`), production
   `liveQuotaProbe` (`:159`). Add a Copilot branch that lists `listCopilotAccounts()`
   (`src/lib/accounts/copilot.ts:108`) and reads `readCopilotTranscriptLimits(account.sessionStateDir)`.
   It should read `authenticated` from `config.json` (§4.1 helper; slice 3 adds a minimal
   `copilotSignedInUser(home): string | null`, and slice 2 builds on it) and use
   `provenance.source: "transcript"`. It never spawns the CLI.
3. **Payload.** `readLimits` (`src/lib/limits.ts:420`) and `LimitsPayload` (grep
   `interface LimitsPayload`) gain `copilot`, `copilotAccountId` and `provenance.copilot`.
   `/api/limits` (`src/app/api/limits/route.ts:10`) passes them through.
4. **Selection.** `src/lib/accounts/manager.ts` blocks automatic Copilot picks in
   three places:
   - `resolveHeadlessSpawn` (`:482-485`) returns `{ kind: "unavailable" }`;
   - `resolveProjectSpawn` (`:514-518`) resolves only a named account;
   - the project-spawn helper at `:301-302` falls back to the active account.
   Replace all three with the same `selectProjectAccount(...)` call the other engines
   use, over `listCopilotAccounts()`. Also fill `limits` in `copilotSummary` (`:362-377`,
   today `unavailableLimits()`) from the latest observation, the way `summary()` does
   for Codex. Check `gatingWindows` (`quotaPolicy.ts`) with a Copilot
   `EngineLimits` (weekly only): a monthly `weekly` at 100 % must refuse the account, and
   a missing observation must behave as it does for Codex.
   - Keep one rule: an account with no observation yet is not "exhausted".
   - Pipelines stay out until slice 4, but `spawn_agent` with no named account can now
     pick one.
5. **UI.** `src/components/CopilotFooterRow.tsx` shows the gating window with
   `LimitRow`, as `LimitsFooter.tsx:359-360` does. `src/components/LimitsFooter.tsx` needs
   no new engine tab.
6. **MCP.** `account_limits`: widen the engine enum at `src/lib/mcp/server.ts:3655` and
   the default engine list at `src/lib/mcp/compactAnswers.ts:249`.
   `src/lib/mcp/schemaParity.test.ts` pins schema parity, so update it together.
7. **Exhaustion evidence (C4).** In `CopilotAcpHost.send`'s rejection path
   (`src/lib/runtime/copilotAcpHost.ts:465`, the `session/prompt` error handler), when
   the error message matches
   `/quota|rate.?limit|limit (reached|exceeded)|exhausted|premium request/i`:
   - emit `{ kind: "limits", snapshot: { engine: "copilot", exhausted: true, message }, seq }`
     (the `limits` RuntimeEvent exists in `src/lib/runtime/engineHost.ts`);
   - log the redacted error once.
   Mark the regex as an assumption in a comment until C4 observes a real one.
8. **Optional, only if the seat asks:** a `--max-ai-credits` launch-profile field. The
   design defers it.

### 3.4 Acceptance tests (run each by path, under an isolated HOME / XDG_CONFIG_HOME / LLV_STATE_DIR / TMPDIR)

- `src/lib/limits/copilotQuota.test.ts`
  - The Free fixture (chat 200 at 99.8 %, premium 0) maps to `weekly.usedPercent ≈ 0.2`,
    `resetsAt` equal to the parsed `resetDate`, and `windowMinutes = 30*1440` for a
    September reset date. `session` is null.
  - A paid fixture (premium 300 at 10 %, chat unlimited) gates on `premium_interactions`.
  - All buckets unlimited produces `weekly: null`.
- `src/lib/limits/copilotTranscriptLimits.test.ts`
  - It finds the snapshot in a line that also holds a 5 MB `requestMessages` string,
    without parsing that string (assert through a spy on `JSON.parse` input length, or a
    time bound).
  - The newest record wins across two files.
  - A truncated last line is skipped.
  - A file with no snapshot returns `source: "unavailable"` with the reason.
- `src/components/rateLimit.test.ts` (extend): `windowLabel` for 30 and 31 days returns
  the month label, and 7 days still returns "Week".
- `src/lib/accounts/manager.test.ts`, or a new `manager.copilotSelection.test.ts`:
  - with two Copilot accounts, one observed at 100 % and one at 10 %,
    `resolveHeadlessSpawn("copilot", null, [], null)` picks the second;
  - with no observations, it picks the active one;
  - Claude and Codex selection is unchanged (reuse an existing case).
- `src/lib/accounts/migration/quotaController.test.ts` (extend): the Copilot probe reads
  the transcript and never spawns a process (inject a spawn port that throws).
- `src/lib/mcp/schemaParity.test.ts`: passes with the widened enum. Plus one
  `account_limits` case for `engine: "copilot"`.
- `src/lib/runtime/copilotAcpHost.test.ts` (extend): a scripted `session/prompt` error
  with a quota message emits a `limits` event and ends the turn `error`.

---

## 4. Slice 2 — sign-in, model catalogue, runtime switching (PR 2)

**Outcome:**

- The Viewer shows whether each Copilot account is signed in and can sign one in with
  the device code on screen, with no terminal step.
- The model picker offers the account's real models, with each model's own effort ladder.
- Model and effort can be changed on a live Copilot conversation. That restarts the
  child and loads the same session.

Order: 4.1 → 4.2 → 4.3 → 4.4. Run captures C1–C3 and C5 before starting 4.2.

### 4.1 Auth state

- `src/lib/accounts/copilot.ts`: add `copilotSignedInUser(home): { host: string; login: string } | null`.
  It reads `config.json`, strips `//` comment lines, returns `lastLoggedInUser` when it
  appears in `loggedInUsers`, and returns null otherwise or when the file is missing.
  Add `auth: "signed_in" | "signed_out" | "unknown"` to `CopilotAccount`
  (`copilot.ts:29`), and compute it in `listCopilotAccounts()` (`:108`).
- `src/app/api/accounts/copilot/route.ts:25` (`copilotAccountsBody`): replace the literal
  `auth: "unknown" as const` with the computed state, and add `user: login`. The user
  name is shown only in the local UI; it never goes into fixtures.
- Optional live check, `probeCopilotAuth(account)`: run `initialize` + `session/new` +
  `session/close`, and map `Authentication required` to `"signed_out_or_locked"`. Run it
  only on demand (a "Check" button), never on a poll. It is free, but it starts a
  process (C7 confirms it is not billed).
- `src/lib/accounts/manager.ts:362-377` (`copilotSummary`): `auth` is hard-coded to
  `{ state: "unknown", … }`. Report `authenticated` or `signed_out` from
  `copilotSignedInUser`, with `checkedAt` set to the `config.json` mtime. Routing is
  already correct: `add` (`:468`), `summary` (`:380`) and `status` (`:451-453`) send
  Copilot through `copilot.ts`.

### 4.2 Device-code sign-in supervisor

- New `src/lib/accounts/copilotLogin.ts`, modelled on `ClaudeLoginSupervisor`
  (`src/lib/accounts/claudeLogin.ts:286`). Reuse its phase vocabulary, `LoginPhase` and
  `LoginOperationSummary` in `src/lib/accounts/contracts.ts`.
  - Spawn `<copilot binary> login --device-code` with
    `copilotChildEnv(process.env, home)` (`copilotAcpHost.ts:148`). Its allowlist keeps
    `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`, which the keyring needs.
  - Parse the verification URL and the `XXXX-XXXX` user code from the output. The formats
    come from C5; keep the regexes beside a comment that quotes the redacted captured
    lines.
  - Phases: `starting` → `awaiting_browser` (expose `loginUrl` plus a new optional
    `userCode` on `LoginOperationSummary`) → `verifying` on exit 0 → `authenticated` once
    `copilotSignedInUser(home)` returns a user, else `failed`. Deadline 15 min. Cancel
    stops the recorded PID only.
- `src/lib/accounts/manager.ts:476-477`: `submitLoginInput` and `cancelLogin` currently
  throw "Claude-operation specific". Route Copilot operation ids to the new supervisor
  (cancel only; there is no input to submit).
- API: extend `src/app/api/accounts/copilot/route.ts` POST with
  `{ action: "login", id }` and `{ action: "cancel-login", operationId }`, and have GET
  return the live operation. Keep `rejectCrossOrigin`.
- UI: `src/components/CopilotFooterRow.tsx` gets a "Sign in" button for a signed-out
  managed account that shows the URL and code while `awaiting_browser`. Keep the copyable
  command as the fallback for a headless machine. Add every string to both i18n files.

### 4.3 Model catalogue

Pick the source from what C1 and C2 show, in this order of preference:

1. **ACP `configOptions` model option** (C1). The host already receives `configOptions`
   from `session/new` in `handshake()` (`copilotAcpHost.ts:393-420`) and drops them.
   Store `{ id, name }[]` per account.
2. **`/model` output over ACP** (C2), if it is free. Parse it in a pure function with a
   captured, scrubbed fixture.
3. **Fallback:** the plan-level lists in `docs/design/copilot-engine.md` §2, the static
   list in `src/lib/agent/models.ts` (the `copilot:` block below the Codex rows,
   commented "auto heads the list…").

Shape and storage:

```ts
// src/lib/agent/copilotModels.ts (new)
export interface CopilotModelEntry { id: string; name: string; efforts: string[] | null; pickerEnabled: boolean }
export interface CopilotModelCatalog { accountId: string; capturedAt: string; source: "acp-config" | "slash-model" | "static"; models: CopilotModelEntry[] }
// persisted at statePath("copilot-model-catalogs.json"), keyed by accountId
```

- Write the file only from a process that owns state: the Viewer or the runtime host
  (§6.1). The host runs in the runtime host, so emit the catalogue as a host event, or
  write it through the existing state helpers there. Do not resolve the state directory
  in a module that loads at import time.
- Merge per-model efforts from C3 (`modelInfo.capabilities.supports.reasoning_effort`)
  when a transcript has seen the model.
- `effortScale("copilot", model)` (`src/lib/agent/efforts.ts:64`) returns the model's
  ladder when known, and the full `ENGINE_EFFORTS.copilot` (`:17`) otherwise. Note that
  the nano model's ladder has no `minimal` and no `max`.
- `validateLaunchModel` (`src/lib/agent/models.ts`, below `ENGINE_MODELS`) accepts
  catalogue ids. Keep the permissive `COPILOT_MODEL_ID` pattern: the CLI remains the
  arbiter.
- The launch surfaces (`src/components/draft/AgentLaunchControls.tsx`) read the catalogue
  through a new `GET /api/accounts/copilot/models?account=<id>`, with `auto` always first.
- Scanner: `src/lib/scanner/model.ts:37-43` gains
  `if (obj.type === "session.auto_mode_resolved") return stringValue(data?.chosenModel);`,
  so an `auto` conversation shows the model it actually ran. Check that `model.*`
  records are **not** matched there: their `model` field includes the background
  `gpt-5.4-nano`.

### 4.4 Model and effort switching on a live conversation

- `src/lib/runtime/structuredControls.ts:245-253`: allow `reconfigure` for Copilot when
  only model and/or effort change. Keep refusing an **account** change, with a clear
  message: a Copilot session lives in its account's `COPILOT_HOME`, and the Viewer never
  copies conversations between accounts.
- `src/lib/runtime/structuredReconfigure.ts:93-96`: remove the Copilot throw. The function
  already takes `release` and `recover` dependencies. The Copilot path is:
  1. release the host;
  2. write the profile patch into the durable launch profile (`claimConversationReconfigure`);
  3. recover, which calls `startCopilotStructuredHost` (`src/lib/runtime/structuredSpawn.ts:1540`)
     with the patched profile, then `CopilotAcpHost.adopt` and `session/load` with the new
     `--model` / `--reasoning-effort`.
  Follow what Claude does here: Claude also has no per-turn model
  (`runtimeSettingsCapability`, `src/lib/runtime/contracts.ts:375`). Leave that function
  returning false for Copilot, because the switch is a restart, not per-turn.
- Before you change anything, read how the reconfigure path treats a **running** turn
  for Claude, and do the same. Do not invent a Copilot-specific wait.

### 4.5 Slice-1 leftovers that belong in slice 2

- **Other granted MCP servers.** `copilotMcpConfig` (`copilotAcpHost.ts:169`) attaches
  only `viewer`. Copy the other granted servers the way `claudeMcpServers` does in
  `src/lib/agent/spawnPolicy.ts`: `grantedMcpServers(allowlist)` → resolved definitions →
  `type: "local"` for stdio, `http`/`sse` as-is.
- **Search index.** `src/lib/search/transcriptSearch.ts:16,35,105,609` are
  `"claude" | "codex"`. Index only `user.message.content` and `assistant.message.content`
  from Copilot transcripts. Never index `model.*` records.
- **An interrupt that never lands** (slice-1 review, finding 2). If the CLI never returns
  a cancelled `session/prompt`, `interrupt()` (`copilotAcpHost.ts:513`) throws after
  10 s. The queue then re-queues the message as `interrupt-auto-retry`, and a fresh
  `session/cancel` goes out every 10 s with no cap.
  - **Fix:** count consecutive failed interrupts per turn in the host. After 3, release
    the host (`release()`, a process-group kill by recorded PID). The queue then sees
    `dead`, puts the message back as `dead-host`, and recovery adopts the session in a
    new child that runs it.
  - **Test** (`copilotAcpHost.test.ts`, with `answerCancel = false`): the third failed
    interrupt leaves the host `dead`, and the recorded PID was signalled.
  - Keep the early `cancelled` answers to open permission requests (review finding 1).
    They are the protocol's requirement and are answered on the wire at that moment.
- **Boot re-adoption** (`src/lib/runtime/startup.ts:1503`). Leave it as is unless the seat
  asks: the next message already resumes the conversation through recovery.

### 4.6 Acceptance tests

- `src/lib/accounts/copilot.test.ts` (extend): `copilotSignedInUser` over fixture
  `config.json` files, covering a comment line, `lastLoggedInUser` not in
  `loggedInUsers`, a missing file and malformed JSON. `listCopilotAccounts` reports `auth`.
- `src/lib/accounts/copilotLogin.test.ts` (new), with a scripted child and no network:
  - the URL and code are parsed from the C5-shaped output;
  - the phases run `starting → awaiting_browser → verifying → authenticated` when the
    child exits 0 and `config.json` names a user;
  - exit 0 with no user gives `failed`;
  - cancel signals exactly the recorded PID;
  - the deadline gives `timed_out`.
- `src/app/api/accounts/route.test.ts` or a new `src/app/api/accounts/copilot/route.test.ts`:
  - GET reports `auth` and the operation;
  - POST `login` starts the operation;
  - a cross-origin POST is rejected.
- `src/lib/agent/copilotModels.test.ts` (new):
  - parse the C1 `configOptions` fixture and/or the C2 `/model` fixture;
  - merge `modelInfo` efforts;
  - `effortScale("copilot", "gpt-5.4-nano")` returns `["none","low","medium","high","xhigh"]`;
  - an unknown model gets the full ladder.
- `src/lib/scanner/model.test.ts` (extend): a real-shaped transcript (session.model_change
  `auto`, auto_mode_resolved, a `gpt-5.4-nano` `model.model_call_started`, then an
  assistant message on `mai-code-1.1-flash`) reports `mai-code-1.1-flash`.
- `src/lib/runtime/structuredReconfigure.test.ts` (extend):
  - a Copilot model/effort reconfigure releases the host and recovers with the patched
    profile;
  - the adopt options carry the new `--model`/`--reasoning-effort` (assert on
    `copilotLaunchArgs`, `copilotAcpHost.ts:189`);
  - an account change is refused with the message.
- `src/lib/runtime/copilotAcpHost.integration.test.ts` (extend the BYOK mode): reconfigure
  a live conversation from effort `xhigh` to `low`. The stub must see `low` on the next
  request, and the transcript must hold one continuous session with `session.resume`.
- `src/lib/runtime/copilotAcpHost.test.ts` (extend): `copilotMcpConfig` includes a
  granted stdio server as `type: "local"` and an http server unchanged.

---

## 5. Slice 4 — pipelines and the orchestrator seat (later PR; waits)

**Outcome:** a pipeline stage, a task fan-out, and the orchestrator seat can run on Copilot.

### 5.1 Engine types to widen

- `RoleEngine` (`src/lib/roles/types.ts:14`) gains `"copilot"`. `FlowEngine` and
  `RuntimeEngine` (`src/lib/flows/types.ts:4`, `src/lib/agent/runtimeConfig.ts:3`) follow
  it.
- Then fix every consumer the compiler flags, and grep for two-engine ternaries (§6.2).
  Known consumers by reference count:
  - `src/lib/pipelines/engine.ts` (12)
  - `src/components/scheme/GroupOverridePanel.tsx` (8)
  - `src/components/onboarding/AgentMappingTable.tsx` (8)
  - `src/lib/onboarding/healthCheck.ts` (7)
  - `src/components/onboarding/OnboardingDialog.tsx` (6)
  - `src/lib/pipelines/types.ts`, `src/components/pipelines/pipelineModel.ts` and
    `src/components/pipelines/StagePlaceholderPane.tsx` (4 each)
  - `src/lib/roles/equivalents.ts` (3)
  - `src/lib/roles/costHints.ts`, `src/lib/pipelines/taskBinding.ts`,
    `src/lib/pipelines/listProjection.ts` and `src/lib/pipelines/durableEvidence.ts`
- `EngineName` (`src/lib/accounts/engineConnection.ts:22`): add Copilot. `engineSignedIn`
  (`:40`) uses slice 2's `auth` state, and `cliResolvable(resolveBinary("copilot"))` uses
  `resolveCopilotBinary`. Update `ENGINE_LABEL`.
- `BindingEngine` (`src/lib/accounts/projectBindings.ts:41`), plus the
  `account_project_binding` enum at `src/lib/mcp/server.ts:3628`.

### 5.2 Refusals to remove

Each one is a comment reading "design slice 4":

- `src/lib/agent/spawnCommand.ts:642` (pipeline membership) and `:958` (adopt a pipeline
  attempt).
- `src/lib/pipelines/engine.ts:986-988` (stage runtime).
- `src/app/api/tasks/[id]/assignment/route.ts:33-34` (task fan-out).
- `src/lib/orchestrator/seatCommand.ts:265-267` (seat eligibility). Its predecessor
  engine types at `:173` and `:1395` are two-engine.
- `src/app/api/orchestrator/seat/status/incumbent.ts:144-145`. It needs a
  `contextWindowPolicyFor("copilot", model)`: take the window from
  `modelInfo.capabilities.limits.max_context_window_tokens` (slice 2 catalogue), else
  use a conservative default.
- `src/lib/orchestrator/handoffDigest.ts:344,359,389`: `lastAssistantReport` must read a
  Copilot transcript (`assistant.message.data.content`).
- MCP enums: `create_pipeline` stage engine (`src/lib/mcp/server.ts:3098`),
  `create_orchestrator` (`:3601`), `rotate_orchestrator` (`:3619`).
- `src/components/draft/AgentLaunchControls.tsx:57`: add Copilot to
  `DEFAULT_LAUNCH_ENGINES` only once the pipeline and seat paths above work.

### 5.3 Selection and readiness

- Stage account resolution goes through `resolveProjectSpawn`. After slice 3 it has
  Copilot capacity.
- `stageEngineRefusal` (`src/lib/pipelines/engine.ts:352`) refuses a Copilot stage with
  nobody signed in, through the same `ENGINE_NOT_CONNECTED` path. Do not fall back to
  another engine.

### 5.4 The behavioural trap: automated senders

Copilot has no steer. A message to a running Copilot turn is delivered by interrupting
it (design §3.4). The default send policy is `interrupt-active`
(`src/lib/runtime/structuredMessageDelivery.ts`, grep `policy: request.policy ?? "interrupt-active"`).

**Audit every automated sender** and decide its policy for a Copilot recipient:

- seat ticks (`src/lib/monitor/seatTickController.ts`, `seatTickSources.ts`);
- `send_message_to_orchestrator`;
- pipeline relays and review-loop messages (`src/lib/pipelines/`, `src/lib/flows/`);
- the bridge (`bridge_directive`);
- `send_message` from other agents.

The rule: an automated message to a busy Copilot agent uses `queue` unless its purpose is
to stop the agent. Otherwise a seat running on Copilot would have its own turn cancelled
by every tick. Put each sender's decision in a table in the PR body.

### 5.5 Acceptance tests

- `src/lib/pipelines/engine.test.ts` (extend):
  - a pipeline with a Copilot stage is created and launched with the Copilot runtime;
  - with no signed-in Copilot account it is refused `ENGINE_NOT_CONNECTED`, with no
    fallback to another engine.
- `src/lib/accounts/engineConnection.test.ts` (extend): Copilot readiness is
  `cli-missing`, then `signed-out`, then `connected`.
- `src/lib/orchestrator/seatCommand.test.ts` (extend):
  - a Copilot conversation is eligible for the seat;
  - the handoff digest reads its last assistant report from a Copilot fixture.
- `src/app/api/orchestrator/seat/status/incumbent.test.ts` (extend): a Copilot incumbent
  reports its context window.
- `src/lib/monitor/seatTickController.test.ts` (extend): a seat tick to a busy Copilot
  seat is admitted with policy `queue` and never interrupts.
- `src/lib/mcp/schemaParity.test.ts`: the widened enums.
- A pipeline case in `copilotAcpHost.integration.test.ts` (BYOK mode): one stage runs on
  Copilot and completes through `stage_report`. The stub has to answer with a
  `viewer-stage_report` tool call, since the Viewer MCP stub is attached.

---

## 6. Traps hit in slice 1

### 6.1 Repository rules that fail silently

- **Never run suites against the operator's live state.** Every test run sets `HOME`,
  `XDG_CONFIG_HOME`, `LLV_STATE_DIR` and `TMPDIR` to a fresh directory under `/var/tmp`,
  and runs **files by path**, one process per file. Never run `bun test src/lib/agent/`
  or any directory sweep: that once killed the operator's live structured host.
- **State ownership.** `stateDir()` refuses a process without `LLV_STATE_OWNER`. A
  module that calls `statePath(...)` at import time breaks the build and the MCP server.
  Resolve state lazily, inside functions (see `AGENTS.md`, "Only a declared owner
  resolves the operator's state directory").
- `bun run build` type-checks more strictly than `tsc` (it includes test files in its
  graph). Run both. Run the build with an isolated config root and
  `env -u __NEXT_PRIVATE_STANDALONE_CONFIG`.
- **`tsc`:** `bunx tsc --noEmit --incremental false > log 2>&1; echo "exit=$?" >> log`.
  A pipe masks the exit code.
- **Privacy gate.** Run `bun scripts/privacy-publication-gate.ts --base $(git merge-base HEAD origin/main)`
  before every push. It flags UUID literals in fixtures, `prompt:`/`user:` transcript
  keys, credential idioms, absolute home paths and account handles. Generate ids at test
  time with `crypto.randomUUID()`.
- **Pre-existing red tests.** These fail at the merge base too, so do not chase them:
  - `src/lib/runtime/structuredDeliveryQueue.recoveryContention.test.ts` (1 test, lock
    message wording);
  - `src/lib/scanner/discover.test.ts`;
  - `src/lib/scanner/discover.performance.test.ts`;
  - `src/app/api/spawn/route.test.ts` (2 tests);
  - timing flakes in `registry.sqlite.test.ts` and one `mcp/server.test.ts` case.
  Check any other red file at the merge base in a temporary `git worktree add --detach`
  with `node_modules` symlinked, then remove the worktree.
- **Commit by path.** Another agent may add files to the same worktree while you work.
  Stage exactly your files (`git add -- <paths>`), and check `git status --short`
  before you commit.
- **Shell.** The shell is zsh. `$R:src/...` is parsed as a history modifier and gives
  "bad substitution". Write `"${R}:src/..."`. `npm` on `PATH` can be a Bun shim that fails
  with `mod.require is not a function`. Install the scratch CLI with
  `PATH=/usr/bin:/bin /usr/bin/npm install @github/copilot@1.0.87` inside a `/var/tmp`
  scratch directory, never globally and never in the repo.

### 6.2 Engine union exhaustiveness

- `Engine`, `AgentEngine` and friends gained `"copilot"` in slice 1. About 100 non-test
  files still spell `"claude" | "codex"`, and about 230 two-way ternaries of the form
  `engine === "claude" ? A : B` silently send Copilot down the Codex branch. The
  compiler catches `Record<Engine, …>` and `switch` exhaustiveness. **It does not catch
  ternaries.** For every file you touch, run
  `rg -n 'engine === "(claude|codex)" \?|"claude" \| "codex"' <file>` and decide each hit.
- **Deliberately two-valued, keep them so unless your slice says otherwise:**
  - `MigrationEngine` (`src/lib/accounts/migration/contracts.ts:9`): never widened;
  - `EngineName` in `engineConnection.ts:22`, `RoleEngine`, `BindingEngine` and the
    orchestrator predecessor types: slice 4;
  - `transcriptSearch.ts` engine: slice 2;
  - `limitsHistoryStore.ts:21` `EngineName`: widen only if slice 3 records Copilot
    history, which is optional.
- Registry refusals keyed on `conversation.engine === "copilot"`
  (`src/lib/agent/registry.ts:1119`, `:1260`) stay. Account migration never covers
  Copilot.

### 6.3 Interrupt-and-resend

The host and queue contract is in design §3.4. The implementation is in
`src/lib/runtime/structuredDeliveryQueue.ts` (grep `steerByInterrupt` and `recordsRoute`)
and `src/lib/runtime/copilotAcpHost.ts:465-535`.

- Never issue a `session/prompt` while one is in flight. `send()` returns
  `{ outcome: "rejected", reason: "stale-turn" }`, and the queue interrupts first.
- `interrupt()` sends `session/cancel` (a notification, so it has no id), then answers
  every open `session/request_permission` with `{outcome:{outcome:"cancelled"}}`, then
  waits at most 10 s for the prompt to return, and throws past that bound. The turn ends
  `interrupted` whatever `stopReason` says.
- The receipt route (`delivery: "interrupt-then-turn-started"`, `interruptedTurnId`):
  - it is written with the `delivering` transition that precedes the interrupt;
  - it is withdrawn with explicit `null`s when the interrupt fails;
  - it is copied onto the registry's delivery owner row at settlement, and
    `message_receipt` answers it.
  Only hosts with `steerFallback: "interrupt"` record it. Claude and Codex receipts must
  not change, and a test pins that.
- The Claude broker's `unsupported-steering` refusal must stay.
- The journal (`src/runtime-host/journal.ts`) admits a Copilot steer through
  `capabilities.steerMode === "interrupt"`. A journal change only takes effect once the
  runtime host runs the new build, so say so in the PR body.

### 6.4 ACP quirks worth a test each time you touch the host

- `--acp` together with `--session-id` exits with a usage error, and the process never
  answers `initialize`. That shows up as a hang in a naive harness, so put a timeout on
  every request.
- `session/new` ignores a client `sessionId`, rejects stdio MCP, and in BYOK returns
  `configOptions` with only `mode` and `allow_all`.
- `session/load` replays history. The host sets `replaying = true` and drops those
  updates (`copilotAcpHost.ts:405-411`, `:811`).
- An agent→client request the client did not advertise (`fs/*`, `terminal/*`) must be
  answered with a JSON-RPC error (`copilotAcpHost.ts:803-806`), or the CLI waits forever.
- `COPILOT_ALLOW_ALL=true`, spelled exactly like that, trusts the folder and loads its
  hooks and MCP servers. The child environment is an allowlist
  (`copilotAcpHost.ts:131-139`), so never add it.
- `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` and `GITHUB_TOKEN` override the stored login, which
  is why they are dropped. A `gh` token would make every account run as its owner.
- Use `--no-auto-update` together with `COPILOT_AUTO_UPDATE=false`, and record
  `agentInfo.version` as `protocolVersion`.

### 6.5 The BYOK stub harness (how to test without spending the allowance)

- The CLI: `LLV_COPILOT_BIN=/var/tmp/<scratch>/node_modules/.bin/copilot`. The gated
  integration test is `src/lib/runtime/copilotAcpHost.integration.test.ts`, which skips
  without the variable. `LLV_COPILOT_REAL_HOME=<real managed home>` enables the
  real-login mode, at about 5 requests per run. Run that mode only when a change needs
  it, and say how many requests it cost.
- The stub is an HTTP server on **port 0** speaking OpenAI chat-completions:
  - A streaming request (`"stream":true` in the body) gets SSE chunks
    (`chat.completion.chunk`), a final chunk with `finish_reason` and `usage`, then
    `data: [DONE]`.
  - A non-streaming request (titles and naming) gets a plain `chat.completion`.
  - A tool call streams `delta.tool_calls: [{ index: 0, id, type: "function",
    function: { name: "bash", arguments } }]` with `finish_reason: "tool_calls"`.
    `index` is required.
  - Choose behaviour by the last user message text: `SLOW` (delay about 15 s), `TOOL`,
    or plain. The next request after a tool call has a `role: "tool"` message last.
  - The user message on the wire starts with a `<current_datetime>…` preamble, so match
    with `includes`.
- The child environment for BYOK goes through the host's test-only
  `providerEnv: { COPILOT_PROVIDER_BASE_URL: "http://127.0.0.1:<port>/v1",
  COPILOT_PROVIDER_TYPE: "openai", COPILOT_PROVIDER_API_KEY: "unused",
  COPILOT_MODEL: "gpt-5.4", COPILOT_OFFLINE: "true" }`. `gpt-5.4` is a model id the CLI
  knows, so `reasoning_effort` appears on the wire and the effort can be asserted.
- **BYOK never produces** `quotaSnapshots`, `model.*` records, `auto_mode_resolved`, a
  `model` config option or `Authentication required`. Test those with scrubbed fixtures
  in unit tests, and with the real mode only when necessary.
- Measured baselines through the Viewer path (BYOK):
  - cancel → running prompt returned: 14–41 ms;
  - cancel → resent turn done: 52–81 ms.
  Assert loose bounds (2 s) so machine load cannot flake them.

---

## 7. Checklist per PR

1. Before any build or test, run `free -m`. Run heavy commands one at a time, and stop
   if less than 4 GB is available.
2. `tsc` (logged exit code), the touched test files by path under isolated state,
   `bun run build` with an isolated config root, and the privacy gate from the merge base.
3. The PR body names:
   - what was verified with the BYOK stub;
   - what was verified on the real account, with the request cost;
   - what is still unverified.
   Features first; issue numbers follow as links.
4. No operator words or quotes in public artifacts. Use English only. No account handles,
   emails or absolute home paths.
