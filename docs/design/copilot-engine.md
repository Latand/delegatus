# GitHub Copilot as a third launchable engine

## The originating requirement

This repository is public, so the operator's own words are not reproduced. The
requirement below is the pipeline's pinned specification (a paraphrase
recorded on 2026-09-22), followed by the orchestrator seat's correction of the
same evening, also paraphrased.

> Operator request, 2026-09-22 (paraphrased in the pinned task "GitHub Copilot
> as a third engine: design, then a launchable first slice"): GitHub Copilot
> becomes a third engine the Viewer can LAUNCH — spawn, send, interrupt,
> resume, pick model and effort, render the conversation — used instead of
> Claude or Codex, not only read. The operator has no Copilot subscription
> today: find out concretely how to get access (Copilot Free, a Pro trial, or
> a paid plan) and what each gives the CLI, so real Copilot launches can be
> tested; paying is acceptable if needed.

> Correction relayed from the orchestrator seat, 2026-09-22 about 20:05Z,
> superseding the specification line about queueing sends during a running
> turn: a message sent to a Copilot agent while its turn is running must reach
> it immediately by interrupt-and-resend — ACP `session/cancel`, a bounded wait
> for the running `session/prompt` to return, then `session/prompt` with the
> new message. The delivery receipt reports this as
> interrupt-then-turn-started, never as `steered`. Where the send path already
> distinguishes delivery modes, Copilot maps steer and interrupt to
> cancel-and-resend; queue stays a client-side queue. #1762 measured the cancel
> returning in about 30 ms; re-measure it.

Every decision below is checked against those two paragraphs in
[Validation against the requirement](#validation-against-the-requirement).
Scope this requirement does not demand is kept under
[Deferred — not currently justified](#deferred--not-currently-justified).

## Evidence discipline

- **Copilot side.** The newest published GitHub Copilot CLI, **1.0.87**
  (`npm view @github/copilot` on 2026-09-22: `latest` = 1.0.87, published
  2026-09-22; `prerelease` = 1.0.88-2), was installed into a scratch
  directory under `/var/tmp`. It was not installed globally or into the
  repository. Every run used a throwaway `COPILOT_HOME` and a throwaway
  `HOME`, with `GH_TOKEN`, `GITHUB_TOKEN` and `COPILOT_GITHUB_TOKEN` unset.
  **No GitHub login was performed and no credential was entered or printed.**
  Real sessions ran in BYOK mode: `COPILOT_PROVIDER_BASE_URL` pointed at a
  loopback stub that speaks the OpenAI chat-completions wire format, bound on
  port 0, with `COPILOT_OFFLINE=true`. `copilot help providers` documents
  that GitHub authentication is not required in that mode. The probes are
  three Node scripts that start `copilot --acp` as their own children and
  kill those children by handle when they finish. Afterwards a `/proc` walk
  found no process left from the scratch directory.
- **Viewer side.** Current `main` at `5ddc67a35`. The worktree was fetched and
  is level with `origin/main`. Line references below are to that tree.
- **Plans and pricing.** GitHub's official pages, read on 2026-09-22 and
  linked in [Access](#2-access-which-plan-gives-the-cli-what). The per-plan
  model lists come from the raw plans page: struck-through entries are the
  models a plan does not include.
- **Prior work.** `search_transcripts` was run project-scoped and unscoped
  for "copilot acp engine", "COPILOT_HOME" and "third engine interrupt resend
  cancel". It found only the #1762 readiness study and an orchestrator relaying
  that study's conclusions. This document builds on #1762 and re-verifies each
  of its CLI facts. Four of them changed in 1.0.87, listed in section 1.

---

## 1. Refreshed facts: Copilot CLI 1.0.87

### 1.1 What held from 1.0.86

| Fact | 1.0.87 evidence |
|---|---|
| ACP server on stdio: `copilot --acp` | `initialize` answered `protocolVersion: 1`, `agentInfo.version: "1.0.87"`, `agentCapabilities: {loadSession: true, mcpCapabilities: {http: true, sse: true}, promptCapabilities: {image: true, audio: false, embeddedContext: true}, sessionCapabilities: {close: {}, list: {}}}`, and one auth method, `copilot-login`, whose `_meta.terminal-auth` names `copilot login`. |
| `session/new {cwd, mcpServers}` | Returns `sessionId`, `modes` (Agent / Plan / Autopilot, as ACP session-mode URLs) and `configOptions`. In BYOK these were `mode` and `allow_all` only; there was no model or effort option. |
| `session/prompt` streams `session/update` | Update kinds seen: `available_commands_update`, `session_info_update`, `config_option_update`, `usage_update`, `tool_call`, `tool_call_update`, `agent_message_chunk`. The result is `{stopReason: "end_turn", usage: {inputTokens, outputTokens, totalTokens, thoughtTokens, cachedReadTokens, cachedWriteTokens}}`. |
| `session/request_permission` | A shell tool call asked `{toolCall: {title, kind: "execute"}, options: [allow_once, allow_always, reject_once]}`. Answering `{outcome: {outcome: "selected", optionId: "allow_once"}}` released it and the turn completed. |
| `session/load` resumes from disk in a new process | A second process loaded the session, replayed its history as `user_message_chunk`, `tool_call`, `tool_call_update` and `agent_message_chunk` updates, then accepted a new prompt. That prompt appended to **the same** `events.jsonl` (`session.shutdown` → `session.resume` → `session.model_change` → `user.message` …). |
| `session/list`, `session/close` | `session/list` → `{sessions: [{sessionId, cwd, title, updatedAt}]}`; `session/close` → `{}`. |
| One process, many sessions | A second `session/new` on the same process returned a second session id. |
| Transcript on disk | `$COPILOT_HOME/session-state/<session-id>/events.jsonl` plus `workspace.yaml` (`id, cwd, client_name, name, user_named, summary_count, fork_count, created_at, updated_at`). The home also holds `config.json`, `session-store.db` (+wal/shm), `logs/` and `installed-plugins/`. |
| Record envelope | Every line is `{type, data, id, timestamp, parentId}`. `session.start.data` carries `sessionId, version: 1, producer: "copilot-agent", copilotVersion: "1.0.87", startTime, reasoningEffort, contextTier, context.cwd, alreadyInUse`. |
| Record types | `session.start`, `session.model_change`, `user.message` (`content, transformedContent, messageId, interactionId, turnId, delivery, …`), `system.message`, `assistant.turn_start`, `assistant.message` (`messageId, model, content, toolRequests, turnId, …`), `tool.execution_start`, `permission.requested`, `permission.completed`, `tool.execution_complete` (`toolCallId, model, success, result, shellExecution, toolTelemetry, …`), `assistant.turn_end`, `abort` (`{reason: "user_initiated"}`), `session.shutdown` (`totalPremiumRequests, totalNanoAiu, modelMetrics, currentModel, codeChanges, …`), `session.resume`. |
| Flags | `copilot --help` lists `--acp`, `--model` ("use 'auto' to let Copilot pick automatically"), `--reasoning-effort` (`none, minimal, low, medium, high, xhigh, max`), `--context {default, long_context}`, `--auto-tier {efficiency, balance, intelligence, fast}` (**`fast` is new**), `--resume`, `--continue`, `--session-id`, `-C`, `--additional-mcp-config`, `--disable-builtin-mcps`, `--allow-all`, `--excluded-tools`, `--max-ai-credits`, `--usage-output-file`, `--no-auto-update`, `--no-custom-instructions`. `--port` is still absent from `--help`. |
| Login | `copilot login --help`: browser flow on a desktop, device code on headless or remote machines, `--with-token` on stdin. `COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN` take precedence over stored credentials. The token goes to the system credential store, or "a plain text config file under ~/.copilot/" when no store is found. Fine-grained PATs with "Copilot Requests", Copilot CLI OAuth tokens and `gh` OAuth tokens are accepted; classic `ghp_` PATs are not. |
| Isolation by directory | Each probe had its own `COPILOT_HOME` with its own `session-state/`, `session-store.db` and `config.json`. There was no crosstalk. |
| Billing and limit help | `copilot help billing`: usage is measured in **AI credits**, shown by footer, `/statusline quota`, `/usage`. `copilot help limits`: `--max-ai-credits` (minimum 30) is a soft per-session cap, with timeline messages near 50/75/90 %. |

### 1.2 What changed or was newly established in 1.0.87

1. **A second `session/prompt` during a running turn now aborts that
   turn.** 1.0.86 left the second prompt unanswered (#1762). In 1.0.87 the
   second prompt, issued 2.5 s into a 15 s turn, aborted the running turn
   (the transcript wrote `abort {reason: "user_initiated"}` and then
   `assistant.turn_end`). The new prompt then ran to `end_turn`. Both
   `session/prompt` calls answered `stopReason: "end_turn"`. This is an
   undocumented implicit interrupt. The design never relies on it and never
   triggers it by accident (see 3.4).
2. **A cancelled prompt reports `stopReason: "end_turn"`**, not the ACP
   `cancelled`. The transcript is the only place that says the turn was
   aborted. The host must therefore remember that it issued the cancel,
   because the protocol does not report it.
3. **`--acp` refuses `--session-id`.** The CLI answered `error: the argument
   '--acp' cannot be used with '--session-id <id>'`. Under ACP the session id
   comes from `session/new`, as Codex's thread id does from `thread/start`.
   `session/new` ignored a `sessionId` passed in its params or `_meta`, and
   returned its own id.
4. **ACP `session/new` rejects stdio MCP servers.** The CLI log line reads
   `Rejecting non-http/sse MCP server "viewer" from client`. The Viewer MCP is
   a stdio server (`viewerMcpServerEntry`, `src/lib/agent/spawnPolicy.ts:83`).
   It attaches through **`--additional-mcp-config` at process start**
   instead: the same stdio definition (`type: "local"`) connected
   (`rmcp::service] Service initialized as client … viewer-stub`), and its
   tool reached the model as **`viewer-viewer_ping`**, prefixed
   `<server>-<tool>`.
5. **Model and effort are fixed per process by flags.** With `--model gpt-5.4
   --reasoning-effort xhigh` on the ACP process, every provider request
   carried `model: "gpt-5.4", reasoning_effort: "xhigh"`, and
   `session.start.data.reasoningEffort` recorded the tier. A process started
   **without** the flag loaded the same session and ran it at `medium`.
   Effort is therefore not persisted with the session; every host start must
   pass it again.
6. **Interrupt-and-resend, re-measured** (three rounds on one process, stub
   provider sleeping 15 s, `session/cancel` sent 2.5 s into the turn,
   measured with `performance.now()`):

   | Round | cancel → running prompt returned | cancel → resent prompt finished |
   |---|---|---|
   | 1 | 8 ms | 30 ms |
   | 2 | 7 ms | 33 ms |
   | 3 | 6 ms | 25 ms |

   Each round wrote `user.message`, `assistant.turn_start`, `abort
   {reason: "user_initiated"}`, `assistant.turn_end`, then the resent
   `user.message` and a complete turn. That agrees with #1762's "returned
   32 ms later"; that figure was cancel → return, and it now measures under
   10 ms.
7. **Viewer-style launch flags work.** `--allow-all` removed the permission
   request (0 requests against 1 without it). `--excluded-tools task
   read_agent write_agent list_agents` removed the native sub-agent tools
   from what the model is offered. The 1.0.87 tool list with nothing excluded
   was `bash, read_bash, stop_bash, list_bash, view, skill, sql,
   session_store_sql, read_agent, list_agents, write_agent, rg, glob, task`.
   It differs from 1.0.86: `grep` became `rg`, and edit tools were not
   offered to this BYOK model. Tool names are CLI-version data, so the design
   reads them from records and hard-codes none of them.
8. **Typed rate-limit classes exist.** `copilot help config` documents
   `continueOnAutoMode`: "eligible rate limit errors (per-model, weekly, or
   integration limits) trigger an automatic switch to auto mode". The CLI
   therefore distinguishes per-model and weekly limits internally. Their wire
   shape was not observable without a subscription (see 3.11).

---

## 2. Access: which plan gives the CLI what

Sources, all read on 2026-09-22:

- Plans and pricing (marketing, with the per-plan model lists):
  <https://github.com/features/copilot/plans>
- Plans for GitHub Copilot (docs): <https://docs.github.com/en/copilot/get-started/plans>
- AI credit billing for individuals: <https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing>
- Getting started with a Copilot plan: <https://docs.github.com/en/copilot/how-tos/manage-your-account/get-started-with-a-copilot-plan>
- Install Copilot CLI (prerequisites): <https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli>
- Pro trials paused: <https://github.blog/changelog/2026-04-10-pausing-new-github-copilot-pro-trials/>
- Plan changes, Opus removed from Pro: <https://github.blog/changelog/2026-04-20-changes-to-github-copilot-plans-for-individuals/>
- Usage-based billing live: <https://github.blog/changelog/2026-06-01-updates-to-github-copilot-billing-and-plans/>
- Individual sign-ups reopening: <https://github.blog/changelog/2026-06-17-copilot-individual-plan-sign-ups-are-reopening/>

| | Copilot Free | Copilot Pro (and its trial) | Copilot Pro+ |
|---|---|---|---|
| Price | $0, "No credit card required" | $10 USD per month | $39 USD per month |
| Copilot CLI | **Included**. The comparison table marks "Use Copilot from your terminal" and "Programmatic mode" Included on Free, and the credit row says "Free plan supports CLI and agent mode". | Included | Included |
| Usage budget | "Limited chat and agent usage". The FAQ on the same page: "limited to 2000 completions and 50 chat requests (including Copilot Edits)". Buying more is "Not included". | $15 of AI credits a month: 1,000 base + 500 flex = 1,500 credits at $0.01 each. Extra credits can be bought under a budget. | $70 a month: 3,900 base + 3,100 flex = 7,000 credits. Extra credits can be bought. |
| Models (plans page, struck-through entries removed) | **Claude Haiku 4.5, GPT-5 mini**. The docs plans page describes Free as "Auto model selection only". | 23 of 34: Haiku 4.5, Sonnet 4 / 4.6 / 5, GPT-5 mini, 5.2, 5.2-Codex, 5.3-Codex, 5.4, 5.4 mini, 5.6 Terra, 5.6 Luna, 6 Luna, MAI-Code-1.1-Flash, Gemini 3.5–3.8 Flash, Grok 4.5–4.7, Kimi K2.7 Code, K3. **No Opus, no Fable, no GPT-5.5 / 5.6 Sol / 6 Astra / 6 Sol.** | All 34, including Opus 4.7–5.5, Fable 5 / 5.1, GPT-6 Astra and Sol. |
| Trial | — | **None available.** New Pro trials were paused on 2026-04-10, and all trials, existing ones included, on 2026-04-13. No reopening notice was found. The current plans page and the getting-started docs offer no trial. | None offered |
| Reset | — | Allowance resets 00:00 UTC on the 1st of each month | same |

Copilot CLI usage consumes AI credits "based on the number of tokens
processed", per the billing and CLI docs. Code completions do not. Upgrading
mid-month charges only the price difference and grants the new plan's
allowance minus what was used (changelog 2026-06-17). A fourth tier, Max
($100, $200 of credits), exists. The requirement does not ask for it.

### Cheapest path for the operator to test real launches

1. **Start on Copilot Free.** It costs nothing, needs no card, and includes
   the CLI and programmatic mode. It is enough to prove login, spawn, send,
   interrupt-and-resend, resume and rendering on a real account with
   `--model auto` or the two Free models. Its budget is small (the FAQ says
   50 chat requests a month), so plan a short scripted smoke test and not
   daily use.
2. **Upgrade to Pro ($10/month) only when needed**: when Free's budget runs
   out, or to exercise the model picker across real models. Pro is the
   cheapest plan with model selection. It lacks Opus, Fable and the top GPT
   tiers, which need Pro+ ($39). There is no trial to wait for.
3. The subscribing GitHub account must be the one that logs in to the
   Viewer-managed `COPILOT_HOME` (3.9). A `gh` token already present in the
   Viewer's environment must never stand in for it; 3.9 strips it.

---

## 3. Engine design

### 3.0 Shape of the decision

Copilot joins as a **structured-only** engine hosted by the runtime host,
alongside the Claude broker and the Codex app-server. It is not a tmux engine.
The project's direction is structured-only (#1161). `spawnTransport.ts` keeps
tmux only as a fallback for deployments without a runtime host, and a new
engine gets no tmux path at all.
The structural precedent is the Codex host. Its identity arrives after start
(`thread/start` ↔ `session/new`), it resumes by loading from disk
(`thread/resume` ↔ `session/load`), and it serves many requests over one
long-lived JSON-RPC child.

| Option | Taken? | Why |
|---|---|---|
| ACP over **stdio**, one `copilot --acp` child per Viewer conversation, owned by the runtime host | **Yes** | This matches how the Claude and Codex children are owned (`ClaudeStreamBrokerHost.start` and `CodexAppServerHost.start`, called through `src/lib/runtime/registry.ts:25-39`), so process identity, the writer claim and kill are reused unchanged. It opens no port. It is also the only way to bind model, effort and MCP config per conversation, because 1.0.87 fixes them per process (1.2 §4–5). |
| ACP over TCP (`--acp --port n`) | No | `--port` is undocumented in `--help`. We need one client, and a listening port is one more thing to collide or expose. |
| One shared `copilot --acp` process per account | No | The model and effort flags are per process, so a shared process would force one model on every conversation of that account. It would also couple the failure of one conversation to all of them. |
| Non-interactive `copilot -p … --output-format json` per turn | No | There is no mid-turn interrupt beyond killing the process, and no permission channel. It would re-pay process start on every turn. |

### 3.1 Scan

- `RootKey` gains `copilot-sessions` (`src/lib/types.ts`).
  `src/lib/scanner/roots.ts` gains `copilotSessionRoots()`, which returns
  `<home>/session-state` for every Copilot account home: each managed home
  (3.9), plus the legacy `$COPILOT_HOME` or `$HOME/.copilot` when it exists.
  Roots are resolved per call, not at import, following the existing
  `openclawSessionRoots()` rule.
- `src/lib/scanner/copilotNative.ts` holds Copilot's rules in one place,
  following the `openclawNative.ts` pattern. **`events.jsonl` is the only
  transcript basename.** `checkpoints/`, `files/`, `research/`,
  `rewind-file-snapshots/`, `workspace.yaml` and the `.workspace-fork.lock` /
  `*.lock` files are sidecars. The session id is the directory name,
  cross-checked with `session.start.data.sessionId`.
- The head reader takes `cwd` from `session.start.data.context.cwd`. The
  model comes from `session.start.data.selectedModel`, then the latest
  `session.model_change` or `assistant.message.model`; effort from
  `session.start.data.reasoningEffort`; the CLI version from
  `copilotVersion`; the title from `workspace.yaml:name`, falling back to the
  first `user.message.content`.
- Project grouping goes through the existing `projectInfoFromCwd`
  (`src/lib/scanner/describe.ts`), so a Copilot session started in a
  worktree groups under its parent repo. A "deleted worktree still groups
  under its parent repo" case for a Copilot transcript is added to
  `describe.test.ts`, as AGENTS.md requires.
- `session-store.db` is not read. It is an undocumented SQLite file with a
  live writer, and `events.jsonl` plus `workspace.yaml` answer every scanner
  question.
- **Tolerance rule.** The record schema is unpublished and the CLI ships
  several releases a week. An unknown `type` is skipped, and a missing field
  degrades that one item, never the session. `copilotVersion` goes into the
  scan record so a parse regression can be tied to a CLI version.

### 3.2 Render

`Fmt` and `FeedEngine` gain `copilot`, and `src/components/feed/parse.ts`
gains a `copilot` branch. The mapping is:

| Record | Feed item |
|---|---|
| `user.message` | user message, from `data.content`. `transformedContent` carries the CLI's injected `<current_datetime>` preamble (seen on the provider wire) and is not rendered. |
| `assistant.message` | assistant text from `data.content`. Each `toolRequests[]` entry opens a tool call keyed by `toolCallId`. |
| `tool.execution_start` / `tool.execution_complete` | tool call and result for that `toolCallId`. `shellExecution.exitCode` and `success` set the result state. `bash` uses the existing shell presentation. A `viewer-<tool>` name (1.2 §4) is presented as the Viewer MCP tool `<tool>`, exactly as `mcp__viewer__<tool>` is for Claude, so MCP redaction and presentation stay one code path. |
| `permission.requested` / `permission.completed` | attention trace, the same as Codex approvals |
| `abort` | "interrupted" marker on the turn |
| `assistant.turn_start` / `assistant.turn_end` | turn boundaries (turn state and the working indicator) |
| `session.start`, `session.resume`, `session.model_change` | trace records (model and effort chips) |
| `session.shutdown` | usage trace. Its `modelMetrics` and `totalNanoAiu` feed the per-conversation usage line only (3.11). |
| `system.message` | not rendered (it is the system prompt) |

Model and effort chips use `effortScale("copilot", …)` (3.8).

### 3.3 Spawn

`CopilotAcpHost.start(options)` in `src/lib/runtime/copilotAcpHost.ts`:

```
copilot --acp --no-auto-update
        -C <cwd>
        --model <model|auto>
        --reasoning-effort <tier>                  (omitted when none chosen)
        --additional-mcp-config <json>             (Viewer MCP, 3.10)
        --disable-builtin-mcps
        --excluded-tools task read_agent write_agent list_agents
        [--allow-all]                              (bypass launch profiles only)
env:    COPILOT_HOME=<account home>  COPILOT_AUTO_UPDATE=false
        minus GH_TOKEN, GITHUB_TOKEN, COPILOT_GITHUB_TOKEN, COPILOT_PROVIDER_*,
        COPILOT_ALLOW_ALL, COPILOT_MODEL  (3.9)
```

Then `initialize`, then `session/new {cwd, mcpServers: []}`. The returned
`sessionId` becomes the durable key `{engine: "copilot", sessionId}`. As with
Codex's provisional `"pending"` thread id (`codexAppServerHost.ts:1428`), the
host is constructed before the id is known and bound to the registry after.

- `agentInfo.version` is recorded as `HostState.protocolVersion`, so every
  conversation names the CLI version that ran it.
- `--no-auto-update` together with `COPILOT_AUTO_UPDATE=false`: the help says
  this also makes the CLI ignore a newer cached version. The binary we
  launched is the binary that runs.
- **Native sub-agents are excluded by tool name**, which is Copilot's
  equivalent of `NATIVE_MULTI_AGENT_TOOLS` for Claude
  (`spawnPolicy.ts:26`). The exclusion was verified in 1.2 §7. `--fleet` is
  never passed.
- `--disable-builtin-mcps` drops the built-in GitHub MCP server. That server
  would act on GitHub with the account's token. This is the Copilot
  equivalent of Claude's `--strict-mcp-config`: only what the launch profile
  grants is attached.
- The spawned process does not trust the working directory:
  `COPILOT_ALLOW_ALL` is removed, and its exact value `"true"` would load the
  folder's skills, plugins, MCP servers and hooks. `--allow-all` grants tool,
  path and URL permission without trusting the folder.
- Permission mode: a bypass launch profile passes `--allow-all`. Any other
  profile leaves it off, and each `session/request_permission` becomes an
  `attention` event answered through `answer()` (3.6).
- `AGENTS.md` custom instructions stay on. They are how a repository
  instructs any agent, Copilot included.
- **Binary.** The image gains `make_nsenter_shim copilot
  '$HOME/.bun/bin/copilot'` beside the `claude` and `codex` shims
  (`Dockerfile:106-107`). The operator installs the CLI once with `bun add -g
  @github/copilot@1.0.87`, pinned exactly, because a caret pin on a bun
  global does not hold. `LLV_COPILOT_BIN` overrides the path for tests. When
  the binary is missing, the spawn is refused with that reason, following the
  same admission path as `structuredSpawnGap`
  (`src/lib/runtime/spawnTransport.ts:41`).
- `structuredSpawnGap` refuses `engine: "copilot"` on a tmux transport. There
  is no tmux path.

### 3.4 Send, and interrupt-and-resend

`send(entry)`:

- **Idle:** mint a turn ref `copilot:<n>`, emit `turn-started`, and issue
  `session/prompt {sessionId, prompt: [{type: "text", text}, …images]}`. ACP
  has no turn id; the minted ref is what `activeTurnRef` names. Return
  `{outcome: "turn-started", turnId}`.
- **A prompt already in flight:** return `{outcome: "rejected", reason:
  "stale-turn"}` and write nothing. This is the guard against 1.2 §1: a
  second `session/prompt` would abort the running turn through an
  undocumented path. The host never lets that happen implicitly. Every
  interrupt is the explicit, recorded one below.

**Interrupt-and-resend** (the correction). The delivery queue already
implements interrupt → re-read health → deliver for the `interrupt-active`
policy (`src/lib/runtime/structuredDeliveryQueue.ts:1125-1215`), and the
composer's default policy is already `interrupt-active`
(`TmuxComposer.tsx:2720`, `:3062`). Copilot therefore reuses that path.
Nothing new is built for it:

1. `interrupt(turnRef)` records the cancel intent, sends the ACP
   notification `session/cancel {sessionId}`, then **waits up to 10 s** for
   the in-flight `session/prompt` to return. The measured return is 6–8 ms,
   so the bound is more than a thousand times that. When the prompt returns,
   the host emits `turn-ended {status: "interrupted"}`, whatever
   `stopReason` said (1.2 §2), and the host reads idle. If the bound expires,
   `interrupt` throws. The queue's existing catch puts the message back as
   `interrupt-auto-retry` (`:1172-1190`), and nothing is sent on top of a
   running turn.
2. The queue re-reads health, sees `idle` (`:1203-1215`), and calls
   `send()`, which issues the new `session/prompt`.
3. **The receipt.** The queue passes the interrupted turn to the send, and
   the settled record carries `delivery: "interrupt-then-turn-started"` and
   `interruptedTurnId` next to the new `turnId`. `message_receipt` and the
   outbox chip show that value. The Copilot path never writes `steered`.

**Mapping of the send path's delivery modes for Copilot:**

| Policy / kind in `structuredDeliveryQueue.ts` | Claude broker today | Codex today | Copilot |
|---|---|---|---|
| `interrupt-active` (composer default) | interrupt, then send | interrupt, then send | **cancel → bounded wait → prompt**, receipt `interrupt-then-turn-started` |
| `steer-if-active`, kind `steer` | refused, `unsupported-steering` (`:1121`) | steered into the turn | **mapped to the `interrupt-active` path**: cancel → bounded wait → prompt, receipt `interrupt-then-turn-started` |
| `queue` | waits for idle | waits for idle | waits for idle: a client-side queue, unchanged |
| idle conversation, any policy | turn-started | turn-started | turn-started |

The capability is declared in the type system instead of hidden in an engine
check. `EngineHost` gains `readonly steerFallback?: "interrupt"`, and
`CopilotAcpHost` sets `supportsSteer = false; steerFallback = "interrupt"`.
In the queue, `maySteer && host.steerFallback === "interrupt"` joins the
existing `shouldInterrupt` branch before the `unsupported-steering` refusal,
so the Claude broker keeps its refusal unchanged. The session capability
record (`contracts.ts:503`) gains `steer: false, steerMode: "interrupt"`. The
composer's steer action (`TmuxComposer.tsx:4124`) then submits with
`interrupt-active` for such a session and is labelled as interrupting and
resending, where it would otherwise show `queue.steerUnsupported`.

### 3.5 Interrupt (stop without a new message)

`interrupt(turnRef)` is the method in 3.4 step 1, used alone. The queue's
`interrupt` effect settles `interrupted` as it does for the other engines.
`kill` is `release()` (3.7) followed by the process-group kill that the
other hosts use.

### 3.6 Attention and permission answers

`session/request_permission` is an agent→client JSON-RPC **request**. The
host keeps its JSON-RPC id, emits `attention {id, method:
"session/request_permission", attention: {toolCall, options}}` and reports
`status: "attention"`. `answer(id, {optionId})` replies with `{outcome:
{outcome: "selected", optionId}}` and emits `attention-resolved "answered"`.
A turn that ends with a request still open emits `attention-resolved
"turn-ended"`. This is the existing event pair and needs no new vocabulary.

### 3.7 Resume and reattach

`CopilotAcpHost.adopt(sessionId, options)` starts a new child with the same
flags, **including `--model` and `--reasoning-effort` from the durable launch
profile**, because a restart without them silently drops to `medium`
(1.2 §5). It then issues `session/load {sessionId, cwd, mcpServers: []}`.

- ACP has no event cursor. Our own `RuntimeEventStore` owns the sequence
  numbers, as it does for Claude, and `initialEventCursor` is carried over
  from the registry exactly as `defaultStartHost` does for the other engines
  (`structuredSpawn.ts:1479-1486`). The history `session/load` replays is
  marked as replay and **not** re-emitted as new items: the feed renders the
  history from `events.jsonl` (3.1–3.2). The replay is only the engine
  proving it holds the session.
- `sessionMaterializationEvidence(clientMessageId)` is `materialized` once
  `events.jsonl` holds a `user.message` for the first prompt. Until then it is
  `absent` while the first turn is live, and `failed` if `session/new` or the
  first prompt errored.
- `release()` sends `session/close`, closes stdin and waits a short bound,
  then kills the process group by the recorded pid. It never kills by
  pattern.
- `health()` reports `active` with a prompt in flight, `attention` with an
  open permission request, `idle` otherwise, and `dead` when the child
  exited. It also carries pid, process start identity and `agentInfo.version`.
- Registry columns use a new `kind: "copilot-acp"`, beside
  `codex-app-server` and `claude-broker` (`registry.ts:48-74`).

### 3.8 Model pick and effort

- **Model.** `ENGINE_MODELS.copilot` (`src/lib/agent/models.ts`) starts with
  **`auto`** at its head. `auto` is the one value every plan accepts,
  including Free ("Auto model selection only"). After it comes a short
  curated list in the dotted id form the CLI uses (`gpt-5.4` in its own help;
  `claude-haiku-4.5`, `gpt-5-mini`, `claude-sonnet-5` from the plans page's
  names). **Those ids are unverified against a logged-in catalogue.**
  `validateLaunchModel("copilot", …)` accepts `auto`, any catalogue entry,
  and any token matching `^[a-z0-9][a-z0-9.-]*$`. The CLI is the arbiter,
  and a refusal surfaces as a spawn failure carrying the CLI's message.
  Reading the real catalogue needs a login and is slice 2.
- **Changing the model or effort of a running conversation** means restarting
  the child with new flags and `session/load`, the adopt path above. Slice 1
  does not offer it: the capability's `runtimeSettings` declares model and
  effort as launch-only for Copilot, so the composer does not show a
  per-turn switch that would be ignored. The switch is slice 2.
- **Effort.** `ENGINE_EFFORTS.copilot = ["none", "minimal", "low", "medium",
  "high", "xhigh", "max"]`, taken verbatim from `--help`. `EFFORT_ORDER`
  (`src/lib/agent/efforts.ts:22`) gains `none` below `minimal`.
  `effortScale("copilot", …)` returns that list. There is no per-model
  scale; the CLI decides what a model supports.
- `--auto-tier`, `--context long_context` and `--max-ai-credits` are
  deferred (see Deferred).

### 3.9 Account isolation

- `AccountContext.engine`, `AccountCatalog` and the `AccountManager` engine
  parameters widen to include `copilot` (`src/lib/accounts/contracts.ts`).
  `src/lib/accounts/copilot.ts` follows `codex.ts`: managed homes at
  `<config>/agent-log-viewer/accounts/copilot/<id>`, created with mode 0700
  and used as `COPILOT_HOME`, with `transcriptRoot = <home>/session-state`.
  The legacy account is `$COPILOT_HOME` or `$HOME/.copilot` when it exists.
  It is scanned but never launched into unless the operator selects it.
- **The spawn environment strips `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` and
  `GITHUB_TOKEN`.** They take precedence over stored credentials (`copilot
  help environment`). A `gh` token in the Viewer's environment would
  otherwise make every Copilot account silently run as whichever GitHub user
  owns that token. The spawn environment also strips `COPILOT_PROVIDER_*`
  (except in tests), `COPILOT_MODEL` and `COPILOT_ALLOW_ALL`.
- **Login, slice 1.** The Accounts panel shows a copyable command for a
  managed Copilot account, `COPILOT_HOME=<home> copilot login
  --device-code`, as `attach-command` does for sessions. Its auth state reads
  `unknown` until the first spawn succeeds or fails on auth. In the
  container, the nsenter shim runs the CLI without a desktop keyring session,
  so the CLI's documented fallback, a plain-text token file inside the home,
  is what keeps two accounts apart. **Whether the fallback file lands under
  `COPILOT_HOME` and not under `$HOME/.copilot` is not verified.** It is the
  first check the operator makes after logging in (slice 1 verification,
  step 2).
- **Automatic account selection.** `resolveHeadlessSpawn` and
  `resolveProjectSpawn` return `unavailable` for automatic Copilot picks.
  With no limit signal (3.11), capacity-aware selection cannot be honest. A
  Copilot launch names its account or uses the active one.

### 3.10 MCP attach

The Viewer MCP attaches **at process start** with `--additional-mcp-config`.
ACP's `session/new` refuses stdio servers (1.2 §4). The definition is built
from the one source the other engines use:

```json
{"mcpServers": {"viewer": {"type": "local", "command": "bun",
  "args": ["<bin/mcp-server.mjs>"], "tools": ["*"],
  "env": {"…viewerMcpServerEnv()…": "…", "LLV_SPAWN_CAPABILITY": "<capability>"}}}}
```

`viewerMcpServerEntry()` and `viewerMcpServerEnv()` (`spawnPolicy.ts:63-94`)
supply command, args and the pinned state directory. The spawn capability
that lets the Viewer MCP attribute calls to this conversation goes into the
server's `env` table **explicitly**, not through inherited environment. Other
granted servers (`grantedMcpServers`) are copied in the same way. The JSON is
written to a 0600 file under the account home and passed as `@<file>`, so the
capability never appears on a command line.

The model sees the tools as `viewer-<tool>`, and 3.2 renders them as Viewer
MCP calls.

### 3.11 Limits

- **What exists.** Per-session accounting: the `session/prompt` result
  `usage`, `usage_update` (context window), and the `session.shutdown`
  record's `modelMetrics`, `totalNanoAiu` and `totalPremiumRequests`. The CLI
  also has internal classes for "per-model, weekly, or integration" rate
  limits (1.2 §8).
- **What does not exist yet.** There is no documented query for the plan's
  remaining AI credits (only the interactive footer, `/statusline` and
  `/usage`), and no observed wire shape for a limit error. Slice 1 therefore
  reports Copilot account limits as `unavailable` (`unavailableLimits()`) and
  keeps Copilot out of automatic selection (3.9). A turn that fails on a
  limit shows up as a failed turn with the CLI's own message.
- Slice 3 captures the real limit-error shape on a logged-in account,
  whether a `session/prompt` JSON-RPC error or a transcript record, and maps
  per-model and weekly limits into `EngineLimits`.

### 3.12 Where the engine identity widens

These are the unions and enums slice 1 widens. Each is listed so that none is
missed: `Engine`, `Fmt`, `TranscriptEngine` (`src/lib/types.ts:14-22`);
`AgentEngine` (`src/lib/agent/cli.ts:30`, `src/lib/scanner/process.ts:14`);
`AgentEngineName` (`efforts.ts:10`); `DraftEngine` (`draftSpawn.ts:17`);
`FeedEngine` (`feed/tools.ts:19`); `AccountEngine`
(`kanban/accountChoice.ts:40`); the `spawn_agent` engine enum
(`src/lib/mcp/server.ts:3196`) and `/api/spawn` validation. The
`create_pipeline` stage engine enum (`server.ts:3097`) stays two-valued in
slice 1 (see slice 4). A repository-wide census found 103 non-test files that
spell `"claude" | "codex"` and 132 that branch on `engine === …`. Most of
them are display helpers that already fall back to a default. The build
stage widens the ones on the launch → host → send → scan → render path and
leaves the rest on their fallback. Anything left falling back is named in the
PR.

---

## 4. Slice plan

### Slice 1 — launchable end to end (the build stage implements this)

**Scope.** Everything in section 3 except what 3.x marks as slice 2 or later:

1. Engine identity widened along the path (3.12).
2. Scan and render: `copilotNative.ts`, the root, the head reader, the
   `copilot` branch in `parse.ts`, the deleted-worktree grouping case (3.1–3.2).
3. Accounts: `accounts/copilot.ts`, managed homes, legacy read, copyable
   login command, token stripping, no automatic selection (3.9).
4. Host: `CopilotAcpHost` with `start`, `adopt`, `send`, `interrupt`,
   `answer`, `health`, `release` and `sessionMaterializationEvidence`, the
   `copilot-acp` registry columns, and the `structuredSpawn.ts` /
   `registry.ts` branches (3.3–3.7).
5. Delivery: `steerFallback` in `EngineHost`, the queue branch, the receipt
   `delivery: "interrupt-then-turn-started"` with `interruptedTurnId`, the
   capability `steerMode`, and the composer's steer action (3.4).
6. Launch surfaces: Copilot in the engine picker of `AgentLaunchControls`,
   with `auto` plus the curated models and the seven-tier effort ladder, and
   in `spawn_agent` / `/api/spawn` (3.8).
7. Viewer MCP attach through `--additional-mcp-config` (3.10).
8. `Dockerfile` shim and the `LLV_COPILOT_BIN` override (3.3).

**Tests** (run by path, under isolated `HOME`, `XDG_CONFIG_HOME` and
`LLV_STATE_DIR`, #1905):

- `copilotAcpHost.test.ts` runs against a scripted fake ACP child injected
  through `spawnProcess`, the same seam `ClaudeStreamBrokerHost` and
  `nativeCodexRuntime.ts` use. It covers: the start flags, including the
  stripped variables and the MCP `@file`; `session/new` → key; update →
  `RuntimeEvent` mapping; a permission request → attention → answer; send
  while in flight → `stale-turn` with nothing written; interrupt → `turn-ended
  interrupted` despite `stopReason: "end_turn"`; interrupt past the bound →
  throws; adopt passes model and effort again and suppresses replay;
  release → `session/close` then kill by recorded pid.
- `structuredDeliveryQueue` cases: `steer-if-active` and `steer` on a
  `steerFallback: "interrupt"` host take the interrupt branch and settle with
  `delivery: "interrupt-then-turn-started"` and never `steered`; `queue`
  waits for idle; the Claude broker's `unsupported-steering` refusal is
  unchanged.
- Scanner and feed: `copilotNative.test.ts` and a `copilot.parse.test.ts`
  over a fixture recorded from a 1.0.87 BYOK run. The fixture is scrubbed
  for publication: session and message ids are generated when the test runs,
  because the privacy gate flags UUID literals, and paths are
  `$HOME`-relative placeholders. It also covers an unknown record type and a
  truncated last line.
- `describe.test.ts`: a deleted Copilot worktree still groups under its
  parent repo.
- **The BYOK integration test.** `copilotAcpHost.integration.test.ts` is
  gated on `LLV_COPILOT_BIN`, the same way the browser drivers are gated on
  `CHROME_BIN`. It starts a loopback chat-completions stub on **port 0**
  with slow, tool-call and plain behaviours selected by prompt text. It then
  spawns through the Viewer's own structured-spawn path with `engine:
  "copilot"`, a scratch `COPILOT_HOME`, `COPILOT_PROVIDER_BASE_URL` at the
  stub, `COPILOT_OFFLINE=true`, a model and an effort. It asserts:
  1. spawn with cwd, model and effort: the stub saw `model` and
     `reasoning_effort` on every request;
  2. the Viewer MCP is attached: the stub saw a `viewer-…` tool in `tools`;
  3. send → `turn-started` → the turn completed;
  4. **interrupt-and-resend**: a send during a slow turn settles
     `interrupt-then-turn-started`, the transcript holds `abort
     {reason: "user_initiated"}` followed by the resent `user.message`, and
     the test logs cancel → prompt-return and cancel → resend-done in
     milliseconds (the expectation from 1.2 §6 is under 50 ms; the assertion
     bound is loose, 2 s, so load cannot flake it);
  5. `interrupt` alone ends the turn as `interrupted`;
  6. resume: the host is released, a new host is adopted on the same session
     id, one more turn is sent, and the stub again sees the launch effort;
  7. the transcript is scanned and parsed into feed items (user, assistant,
     tool call and result, interrupted marker) in the same run;
  8. account isolation: a second account's scratch `COPILOT_HOME` holds no
     session of the first.
  This test is the **scripted end-to-end run** the acceptance asks for. It
  drives the real CLI, and it adds no one-shot driver script.

**Gates**, as the pinned task states them: `bunx tsc --noEmit --incremental
false` with its exit code logged; the touched tests by path; `bun run build`
with an isolated config root; the privacy gate from the merge base; `free -m`
before each heavy command, run one at a time and never below 4 GB available.

**What slice 1 verifies and what it does not.** The PR says it plainly:

- *Verified in the lane:* every behaviour above against the real Copilot CLI
  1.0.87 in BYOK mode.
- *Not verified in the lane, and the operator's step after logging in:*
  1. install the pinned CLI on the host and start a Copilot Free account,
     using the login command from the Accounts panel;
  2. check that the credential landed inside the managed `COPILOT_HOME`,
     that `$HOME/.copilot` was not created or changed, and that a second
     managed account is still signed out;
  3. launch one Copilot conversation with `--model auto`, send, send again
     mid-turn (interrupt-and-resend), stop, resume, and check the rendered
     feed;
  4. note the model ids the account's `/model` offers, as input for slice 2.

### Slice 2 — catalogue and runtime switching

- Read the account's real model catalogue after login. The candidates are
  the ACP `configOptions` (a `model` option was not present in BYOK) and the
  `/model` command advertised in `available_commands_update`. Replace the
  curated list, and hide models the plan does not include.
- Change model or effort on a live conversation by restarting the child and
  calling `session/load` (3.7). Declare that change in `runtimeSettings`.
- Automate the device-code login in the Accounts panel, as the Codex device
  flow is automated. Show auth state from the credential file.

### Slice 3 — limits

- Capture the real per-model and weekly limit errors on a logged-in account,
  map them into `EngineLimits` and the limits footer, and let Copilot accounts
  take part in capacity-aware selection.
- Optional per-launch `--max-ai-credits` cap from the launch profile.

### Slice 4 — pipelines and orchestration

- Copilot as a pipeline stage engine (`create_pipeline` stage enum, role
  presets) and as an orchestrator seat engine, once slices 1–3 have run on a
  real account.

---

## 5. Risks

1. **P1: The transcript schema is unpublished and moves.** 1.0.87 already
   renamed a tool (`grep` → `rg`) and changed prompt-concurrency semantics
   (1.2 §1). Mitigations: the tolerance rule (3.1), `copilotVersion` in scan
   records, the exact version pin and `--no-auto-update` (3.3), and the
   gated integration test, re-run whenever the pin moves.
2. **P1: Credential isolation depends on a fallback not yet observed.** 3.9
   step 2 is the check. If the token lands in a shared keyring or in
   `$HOME/.copilot`, the fix is the documented env token: store a
   fine-grained PAT with "Copilot Requests" per account and inject it as
   `COPILOT_GITHUB_TOKEN` into that account's spawns only.
3. **P1: The implicit abort on a concurrent prompt (1.2 §1).** It is guarded
   by the host's `stale-turn` refusal, and a unit test pins that refusal. If
   a future CLI makes a concurrent prompt steer, it becomes a capability to
   adopt, not a bug.
4. **P2: The curated model ids are unverified.** `auto` works on every plan.
   A wrong id fails loudly at spawn. Slice 2 replaces the list.
5. **P2: No plan-limit signal.** This is why Copilot is kept out of automatic
   selection (3.9, 3.11).
6. **P2: Free's budget is small** (50 chat requests a month per the FAQ). A
   real-account test on Free has to be a short script.
7. **P3: ACP is a public preview.** The stdio surface used here is the
   documented one. `--port` stays unused.

## Validation against the requirement

| Requirement | Where it is met |
|---|---|
| Launch: spawn | 3.3; slice 1 items 4, 6 and 8 |
| Send | 3.4 |
| Interrupt | 3.4 step 1 and 3.5 |
| Mid-turn message by interrupt-and-resend: cancel, bounded wait, prompt; receipt `interrupt-then-turn-started`, never `steered`; steer and interrupt mapped; queue stays client-side | 3.4 (mapping table), slice 1 item 5, test 4 |
| Re-measure the cancel | 1.2 §6: 6–8 ms to return, 25–33 ms to a finished resend |
| Resume | 3.7, test 6 |
| Pick model | 3.8 (`auto` plus curated ids in slice 1; the real catalogue in slice 2) |
| Pick effort | 3.8, verified on the wire in 1.2 §5 and in test 1 |
| Render the conversation | 3.1–3.2, test 7 |
| Used instead of Claude or Codex | launch surfaces and `spawn_agent` (slice 1 item 6); per-account homes (3.9); Viewer MCP attached (3.10) |
| Access: Free, Pro trial, paid, and what each gives the CLI; the cheapest path | section 2 |

The first-slice verdict from #1762 (read-only first) is **superseded** by this
requirement. The operator asks for launch, not reading, and the two rows that
made #1762 defer hosting now have answers. Steering is replaced by
interrupt-and-resend by decision, and limits are kept out of automatic
selection until a signal is observed.

## Deferred — not currently justified

- **ACP over TCP (`--port`) and a shared process per account.** They do not
  help one-conversation-one-child hosting, and per-process model and effort
  rule out sharing (3.0).
- **Relying on the CLI's implicit abort-on-concurrent-prompt.** It is
  undocumented. The explicit cancel is measured and recorded.
- **Reading `session-store.db`.** `events.jsonl` and `workspace.yaml` answer
  every scanner question.
- **`--auto-tier`, `--context long_context`, `--mode plan|autopilot`,
  `--max-autopilot-continues`, `--fleet`.** The requirement names model and
  effort. None of these is asked for, and autopilot and fleet run against the
  Viewer's own orchestration.
- **Copilot's experimental sandbox and `--assisted-approval`.** Both are
  experimental. The Viewer's own access fences are the ones that hold.
- **BYOK as a production mode** (a Copilot engine backed by the operator's
  own provider keys). It is only a test instrument here. The requirement is
  about Copilot subscriptions.
- **Copilot Max.** Pro+ already includes every model. Max adds only volume.
- **An ADR.** Every decision here reverses cheaply: one host class, one
  queue branch, one receipt field.
