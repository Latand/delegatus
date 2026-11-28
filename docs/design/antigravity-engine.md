# Antigravity CLI (`agy`) as a Delegatus Engine

## 1. Originating requirement and scope

Delegatus needs Antigravity CLI (`agy`, measured at version `1.5.13`, installed at `$HOME/.local/bin/agy`) as a launchable structured engine on par with Claude, Codex, and GitHub Copilot, including conversation control through the HTTP and MCP APIs.

Priority order for delivery:

1. **Launch (Slice 1):** `engine: "antigravity"` through `POST /api/spawn`, the MCP `spawn_agent` tool, and pipeline stages. Models and reasoning effort come from `agy models` and ACP `configOptions` (for example `gemini-4-neon` / `gemini-4-neon-xhigh`, with effort `low` through `max` as accepted by the model). The role registry offers Antigravity models and efforts as choices.
2. **Conversation control through API (Slice 2):** Send, interrupt, kill, and resume through `/api/conversation-host` with durable delivery receipts (`message_receipt`). Mid-turn delivery uses the Copilot interrupt-and-resend contract (`session/cancel`, bounded wait, `session/prompt`) and reports `delivery: "interrupt-then-turn-started"` (never `steered`).
3. **Board rendering and search (Slice 3):** The conversation appears as a board card showing user and assistant messages, tool calls and results, and turn/stop state. Full-text search (`search_transcripts`) and normalized paged reading (`conversation_messages`) read it.
4. **Accounts and quota reporting (Slice 4):** At minimum, a `RESOURCE_EXHAUSTED` (`"Individual quota reached ... Resets in ..."`) failure surfaces in account limits with its computed reset time against the 5-hour per-Google-account window, and the conversation card shows why the agent stopped.
5. **Explicitly deferred:** Read-only detection of `agy` sessions started outside Delegatus (for example interactive terminal or tmux sessions), switching between multiple Google accounts, and `agy remote-control`.

Every slice ships as its own proposal PR with unit tests, concurrency/isolation/mutation tests, and an end-to-end check against a scratch Delegatus instance running under an isolated state root and a non-8898 port.

---

## 2. Evidence discipline and measured `agy 1.5.13` facts

### 2.1 Sources

Two sources were inspected on 2026-11-20:

- This repository at `origin/main` `9de765b69`, including the recent Copilot and OpenClaw engine additions (`docs/design/copilot-engine.md`, `docs/design/copilot-slices-2-4-plan.md`, `docs/design/copilot-stage-engine.md`, `docs/design/openclaw-engine.md`) and the architecture redesign work (`#4280`–`#4290`, PR `#4291`, PR `#4293`, PR `#4297`).
- Direct short probes of `agy 1.5.13` (`$HOME/.local/bin/agy`) executed in throwaway scratch directories under `/tmp` at low effort (`gemini-3.8-flash-low` / `gemini-3.8-flash` + `thought_level: "low"`), with every spawned child process terminated immediately after each probe.

No account email, handle, token, absolute home path, or real conversation UUID from those probes is reproduced here; all identifiers below are abstract placeholders (`<session-id>`, `<tool-call-id>`).

### 2.2 Corrections to initial assumptions

Probing `agy 1.5.13` changed five starting assumptions:

1. **ACP (`agy acp`), not print-mode `stream-json`, is the right structured-host transport.**
   `agy -p --input-format stream-json --output-format stream-json` was probed first:
   - Passing `-p --input-format ...` fails because `-p` consumes `--input-format` as prompt text (`Error: -p took "--input-format" as its prompt`); callers must pass `-p=`.
   - Stdin does not use Claude's `{"type": "user", ...}` envelope; it requires `{"event": "user", "message": {"role": "user", "content": "..."}}`.
   - Stdout emits `init` (`{ event, conversation_id, init: { model, cwd, tools, permission_mode } }`), `step_update` (`{ event, step_update: { conversation_id, step_index, state, step_type, text_delta, duration_seconds, usage } }`), and `result` (`{ event, result: { conversation_id, status, response, duration_seconds, num_turns, usage } }`).
   - Print-mode `stream-json` provides no structured JSON-RPC `session/cancel`, no `session/set_config_option`, no per-session `mcpServers` list without editing global `~/.gemini/config/mcp_config.json`, no interactive `session/request_permission` channel, and no `_meta.antigravity.systemPrompt.append`.
   - By contrast, **`agy acp`** speaks ACP JSON-RPC 2.0 over stdio — the same protocol family `CopilotAcpHost` already implements (`src/lib/runtime/copilotAcpHost.ts`) — and natively supports every one of those capabilities.

2. **`session/new` natively accepts both stdio and HTTP MCP servers.**
   Unlike GitHub Copilot CLI (where ACP `session/new` rejects stdio MCP servers and requires `--additional-mcp-config @file`), `agy acp` accepted a stdio MCP server in `session/new { cwd, mcpServers: [{ name: "viewer", command, args, env }] }` and invoked its tool live (`mcp_viewer_<tool>`). It also accepted HTTP MCP descriptors (`{ type: "http", name, url, headers }`) and `additionalDirectories` in `session/new`.

3. **`session/resume` restores context with zero replay traffic, and resets the active model.**
   - `session/load { sessionId, cwd, mcpServers }` replays the entire prior transcript as `session/update` notifications (`user_message_chunk`, `tool_call`, `agent_message_chunk`, `session_info_update`, `usage_update`) before returning.
   - `session/resume { sessionId, cwd, mcpServers }` restores full conversation memory (verified live across two separate `agy acp` processes) with **0 replay notifications**.
   - Both `session/load` and `session/resume` reset `currentModelId` to the account default (`gemini-4-neon-high`). Therefore **every fresh start and every resume must explicitly call `session/set_config_option`** for `model` and `thought_level`.

4. **Model IDs in `agy models` are combined `<base>-<effort>`, while ACP exposes separate `model` and `thought_level` options.**
   `agy models` prints 23 tab-separated lines `<modelId>\t<displayName>` (with `"Fetching available models..."` on stderr). ACP `session/new` returns the same 23 entries in `models.availableModels` alongside structured `configOptions`:
   - `id: "model"` (category `"model"`): base model IDs (`gemini-4-neon`, `gemini-4-argon`, `gemini-4-hydrogen`, `gemini-pro-orchestrator-neon`, `gemini-pro-orchestrator-g1-pro`, `gemini-3.8-flash`, `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-oss-120b-medium`).
   - `id: "thought_level"` (category `"thought_level"`): model-specific ladder (`low`, `medium`, `high`, `xhigh` on `gemini-4-neon`). Requesting `thought_level: "max"` on `gemini-4-neon` returns JSON-RPC error `-32602` (`Thinking level "max" is not offered for model "Gemini 4 Neon"`), even though `agy --help` documents `--effort (low|medium|high|xhigh|max)`.
   - `id: "mode"` (category `"mode"`): `default`, `accept-edits`, `auto`, `plan`.

5. **CLI state isolation vs. Google OAuth credential scope.**
   - Passing an absolute path to `--app-data-dir` fails with `-32603` (`language server failed to start: must not be absolute`). `--app-data-dir` and `--gemini-dir` are relative names under `$HOME`.
   - Running `agy acp` with a fresh scratch `HOME` (plus scratch `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_CACHE_HOME`) isolates all CLI state (`$HOME/.gemini/antigravity-cli/{conversations,brain,cache,log,conversation_summaries.db}`, `$HOME/.gemini/config/`) into the scratch `HOME`, so tests never touch the operator's `~/.gemini/antigravity-cli/`.
   - However, Google OAuth authentication still resolved to the host machine's signed-in Google account (`Google AI Pro`, `g1-pro-tier`) even under a scratch `HOME`. Because `agy` does not isolate Google OAuth tokens per directory out of the box, v1 models a single host Antigravity account (`"default"`) and defers multi-account Google switching honestly.

### 2.3 Measured `agy acp` protocol surface (`1.5.13`)

Command line:

```text
agy acp --disable-telemetry [--dangerously-skip-permissions] [--add-dir <dir> ...]
```

Verified JSON-RPC 2.0 handshake and lifecycle:

| Step | Method / Direction | Measured payload & result |
|---|---|---|
| Initialize | `initialize` (client → agent) | Params `{ protocolVersion: 1, clientCapabilities: {} }`. Result: `protocolVersion: 1`, `agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" }`, `agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, sessionCapabilities: { resume: {}, close: {}, load: {}, list: {}, additionalDirectories: {} }, auth: { logout: {} }, _meta: { antigravity: { tier: true, systemPrompt: { append: true } } } }`, `authMethods: ["oauth-personal", "oauth-business", "gemini-api-key", "agent-platform"]`. |
| Create session | `session/new` (client → agent) | Params `{ cwd, mcpServers, additionalDirectories?, _meta?: { antigravity?: { systemPrompt?: { append: string } } } }`. Result: `{ sessionId, models: { availableModels, currentModelId }, modes: { currentModeId, availableModes }, configOptions, _meta: { antigravity: { tier: { name, id, upgradeUri } } } }`. |
| Resume session | `session/resume` (client → agent) | Params `{ sessionId, cwd, mcpServers }`. Result: same metadata shape as `session/new`, **0 replayed `session/update` notifications**, conversation memory preserved across process restarts. |
| Configure model / effort / mode | `session/set_config_option` (client → agent) | Params `{ sessionId, configId: "model" \| "thought_level" \| "mode", value }`. Result returns updated `configOptions` (reflecting the newly selected model's `thought_level` options). Invalid values return JSON-RPC error `-32602`. |
| Send turn | `session/prompt` (client → agent) | Params `{ sessionId, prompt: [{ type: "text", text }, { type: "image", mimeType, data } ...] }`. Result: `{ stopReason: "end_turn" \| "cancelled", usage: { inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, thoughtTokens, totalTokens } }`. |
| Stream updates | `session/update` (agent → client notification) | `params.update.sessionUpdate` observed kinds: `config_option_update`, `available_commands_update`, `usage_update` (`{ used, size }`), `session_info_update` (`{ title }`), `agent_message_chunk` (`{ content: { type: "text", text } }`), `tool_call` (`{ toolCallId, name, args, status: "in_progress", kind, title, rawInput }`), `tool_call_update` (`{ toolCallId, name, args, status: "completed", kind, title, rawInput, rawOutput: { output, exit_code }, content: [{ type: "content", content: { type: "text", text } }] }`). Note: `agent_thought_chunk` was not emitted in `1.5.13` even when `usage.thoughtTokens > 0`. |
| Cancel turn | `session/cancel` (client → agent notification) | Params `{ sessionId }`. Measured cancel latency: **14 ms** from `session/cancel` write to `session/prompt` returning `{ stopReason: "cancelled" }`. Immediate follow-up `session/prompt` succeeds with `{ stopReason: "end_turn" }`. |
| Concurrent prompt | 2nd `session/prompt` while 1st in flight | Both settled with `end_turn` without documented steer semantics. Host refuses concurrent `send()` with `stale-turn` and routes mid-turn messages through `interrupt-and-resend`. |
| Close session | `session/close` (client → agent) | Params `{ sessionId }`. Result: `{}`. |
| MCP tool naming | `mcpServers: [{ name: "viewer", ... }]` | Model calls tools named `mcp_viewer_<tool>` (general pattern `mcp_<server>_<tool>`). |

### 2.4 Measured model catalogue (`agy models`, `1.5.13`)

| Base model ID (`configOptions.model`) | Offered `thought_level` values | Combined IDs from `agy models` |
|---|---|---|
| `gemini-4-neon` | `low`, `medium`, `high`, `xhigh` | `gemini-4-neon-{low,medium,high,xhigh}` |
| `gemini-4-argon` | `low`, `medium`, `high` | `gemini-4-argon-{low,medium,high}` |
| `gemini-4-hydrogen` | `low`, `medium`, `high`, `xhigh` | `gemini-4-hydrogen-{low,medium,high,xhigh}` |
| `gemini-3.8-flash` | `low`, `medium`, `high` | `gemini-3.8-flash-{low,medium,high}` |
| `claude-opus-5-5` | `low`, `medium`, `high` | `claude-opus-5-5-{low,medium,high}` |
| `claude-sonnet-5-5` | `low`, `medium`, `high` | `claude-sonnet-5-5-{low,medium,high}` |
| `gpt-oss-120b-medium` | `medium` (fixed) | `gpt-oss-120b-medium` |
| `gemini-pro-orchestrator-neon` | none (fixed) | `gemini-pro-orchestrator-neon` |
| `gemini-pro-orchestrator-g1-pro` | none (fixed) | `gemini-pro-orchestrator-g1-pro` |

---

## 3. Architecture

### 3.1 Alignment with the `#4280`–`#4290` redesign

Recent architecture work (`ARCHITECTURE-REVIEW-20261120.md`, `#4280`–`#4290`, PR `#4291` `docs/design/unified-owner-facts.md`, PR `#4293` bounded controller jobs, PR `#4297` dead scanner removal) sets strict invariants for every new engine:

- **Record facts once at their owner; read by identity.** `AntigravityAcpHost` records its session identity, host kind (`"antigravity-acp"`), transcript path, active turn ref, and quota observations once through the existing owner boundaries (`AgentRegistry`, `AgentStateService`, `QuotaController`). All new lookups use indexed identity reads (`registryConversationsForEntryKey`, `registryRowsMatching`, `startupHostSnapshot`, `readKeyed`) — **zero new full scans** of `file.conversations`, `file.entries`, `file.heldDeliveries`, or all hosts.
- **No unbounded background work or hidden polling.** Antigravity model discovery runs passively on `session/new` / `session/resume` (from ACP `configOptions` + `models.availableModels`) and on explicit/bounded `agy models` refresh with a strict timeout; quota reads inspect at most the newest 5 transcripts backwards with a 16 MiB file cap (`readAntigravityTranscriptLimits`), never spawning `agy` on periodic quota ticks.
- **No dead scanner paths.** Scanner integration wires exclusively into the active scanner pipeline (`roots.ts`, `discover.ts`, `describe.ts`, `activity.ts`, `model.ts`, `effort.ts`, `scanCache.ts`, `index.ts`) — never into removed paths.
- **Caller-safe reads and concurrent SQLite writers.** Every store/cache helper added for Antigravity (model catalog, account registry, quota reader, transcript search migration) returns caller-owned copies (never shared mutable references), uses atomic rename or SQLite transactions for writes, and is tested with concurrent writers and a second SQLite connection.

### 3.2 Host-owned NDJSON transcript (`events.jsonl`)

Native `agy` persists trajectories as protobuf blobs inside `$HOME/.gemini/antigravity-cli/conversations/<sessionId>.db` (`trajectory_meta`, `steps`, `gen_metadata`, `executor_metadata`, `parent_references`, `trajectory_metadata_blob`). Delegatus **does not decode those protobuf tables**.

Instead, `AntigravityAcpHost` writes its own append-only NDJSON transcript at:

```text
<config>/agent-log-viewer/accounts/antigravity/<accountId>/sessions/<sessionId>/events.jsonl
```

Because `<config>/agent-log-viewer/` is derived from `stateDir()` (`src/lib/configDir.ts`), transcripts are automatically isolated under `LLV_STATE_DIR` / `XDG_CONFIG_HOME` in tests and scratch instances, while `agy`'s own `$HOME/.gemini/antigravity-cli/conversations/<sessionId>.db` remains intact for `session/resume`.

Each line is a self-contained JSON object `{ schemaVersion: 1, type, id, timestamp, data }`:

| Record `type` | Written when | Key `data` fields |
|---|---|---|
| `session.start` | `session/new` completes | `{ sessionId, cwd, model, effort, baseModel, agyVersion, tier }` |
| `session.resume` | `session/resume` completes | `{ sessionId, cwd, model, effort, baseModel, agyVersion }` |
| `session.model_change` | `session/set_config_option` changes model or `thought_level` | `{ model, effort, baseModel }` |
| `user.message` | `send()` dispatches `session/prompt` | `{ turnId, entryId, content, imageCount }` |
| `assistant.turn_start` | `send()` begins turn | `{ turnId }` |
| `assistant.message` | `agent_message_chunk` accumulated and flushed before a tool call or at turn end | `{ turnId, messageId, content, model, effort }` |
| `tool.execution_start` | `session/update` `tool_call` (`in_progress`) | `{ turnId, toolCallId, toolName, kind, title, arguments }` |
| `tool.execution_complete` | `session/update` `tool_call_update` (`completed` / `failed`) | `{ turnId, toolCallId, toolName, status, exitCode, output, isError }` |
| `assistant.turn_end` | `session/prompt` resolves with `end_turn` / `max_tokens` | `{ turnId, stopReason, usage }` |
| `abort` | `session/prompt` resolves cancelled or interrupted | `{ turnId, reason: "user_initiated" \| "timeout" \| "host_release" }` |
| `session.quota_exhausted` | `session/prompt` rejects with `RESOURCE_EXHAUSTED` / quota error | `{ turnId, code: "RESOURCE_EXHAUSTED", message, resetsAt, windowMinutes: 300, model, observedAt }` |
| `session.error` | `session/prompt` rejects with a non-quota error | `{ turnId, code, message }` |
| `session.shutdown` | `release()` completes | `{ reason }` |

Why a dedicated host-written NDJSON transcript:

- Zero coupling to unpublished protobuf schemas.
- Deterministic `sessionMaterializationEvidence`: `materialized` as soon as the first `user.message` line is flushed to `events.jsonl`.
- Deterministic `agentState` turn-boundary reconciliation (`src/lib/agentState/nativeTurnState.ts`): `user.message` / `assistant.turn_start` open a turn; `assistant.turn_end` / `abort` / `session.quota_exhausted` / `session.error` / `session.shutdown` close it cleanly.
- Every reader (`antigravityNative.ts`, `parse.ts`, `reader.ts`, `transcriptSearch.ts`, `antigravityTranscriptLimits.ts`) skips unknown record types and partial trailing lines tolerantly.

### 3.3 `AntigravityAcpHost` (`src/lib/runtime/antigravityAcpHost.ts`)

Modelled directly on `CopilotAcpHost` (`src/lib/runtime/copilotAcpHost.ts`), implementing `EngineHost` with registry host kind `"antigravity-acp"`:

- **Binary resolution (`src/lib/agent/cli.ts`):**
  - `resolveAntigravityBinary(env)`: `env.LLV_ANTIGRAVITY_BIN?.trim() || resolveBinary("antigravity")` (searching `$HOME/.local/bin/agy` and `PATH` for `agy`).
  - `antigravityBinaryGap(env)`: returns a clear install/override diagnostic if `agy` is missing or not executable.
  - `Dockerfile`: add `make_nsenter_shim agy '$HOME/.local/bin/agy'` beside `claude`, `codex`, and `copilot`.
- **Spawn arguments (`antigravityLaunchArgs`):**
  - `["acp", "--disable-telemetry"]`
  - Add `"--dangerously-skip-permissions"` when `options.allowAll` (bypass launch profile) is true; otherwise `session/request_permission` requests surface as `attention` events answered through `answer()`.
  - Add `"--add-dir", dir` for any configured additional workspace directories.
  - Never pass `--sandbox` or `--remote-control` (deferred).
- **Child environment (`antigravityChildEnv`):**
  - Allowlist mirroring `copilotChildEnv`, preserving `PATH`, `HOME`, `XDG_*`, `LANG`/`LC_*`, `TMPDIR`, and `NODE_EXTRA_CA_CERTS` while stripping `LLV_SPAWN_CAPABILITY`, `ANTHROPIC_*`, `OPENAI_*`, `COPILOT_*`, `GH_TOKEN`, and `GITHUB_TOKEN`.
  - Repository publication identity (`repositoryPublicationSource`) is resolved before allowlisting, matching `CopilotAcpHost.open`.
- **MCP attachment (`antigravityMcpServers`):**
  - Built from `viewerMcpServerEntry()` / `viewerMcpHttpUrl()` + `grantedMcpServers(allowlist)` and passed directly in `session/new` and `session/resume` `mcpServers`.
  - For stdio servers (`viewer` when stdio transport is active, or granted stdio servers): `{ name, command, args, env }` where `env` carries `LLV_SPAWN_CAPABILITY` explicitly (never in the child process environment or command line).
  - For HTTP servers (`viewer` when HTTP transport is active, or granted HTTP servers): `{ type: "http", name, url, headers }` where `headers` carries `X-Delegatus-Spawn-Capability` and `X-Delegatus-Access-Token` as an ACP header array (`[{ name, value }]`).
- **System prompt append:**
  - Learned rules and role instructions (`learnedRulesForLaunchProfile`) pass through `_meta: { antigravity: { systemPrompt: { append } } }` on `session/new`.
- **Model & effort application on start and resume:**
  - `resolveAntigravityModelAndEffort(model, effort)` handles both combined `agy models` IDs (e.g. `gemini-4-neon-xhigh` → `{ baseModel: "gemini-4-neon", thoughtLevel: "xhigh" }`) and separate base model + effort (`model: "gemini-4-neon", effort: "xhigh"`). Explicit `effort` overrides any effort suffix on `model`.
  - After `session/new` or `session/resume`, call `session/set_config_option` for `model` (if specified) and then for `thought_level` (if specified and offered by the model's `configOptions`; otherwise surface the CLI's `-32602` error clearly without silently downgrading).
  - Persist discovered models and per-model `thought_level` ladders into the Antigravity model catalog (`statePath("antigravity-model-catalogs.json")`), atomically written and never read at module import time.
- **Turn serialization & interrupt-and-resend:**
  - `readonly supportsSteer = false;`
  - `readonly steerFallback = "interrupt" as const;`
  - `send(entry)` while a prompt is in flight returns `{ outcome: "rejected", reason: "stale-turn" }` and writes nothing.
  - `interrupt(turnRef)` records cancel intent, sends `session/cancel { sessionId }`, answers any open `session/request_permission` requests with `{ outcome: { outcome: "cancelled" } }`, and waits up to `10_000 ms` (measured return is **14 ms**) for the in-flight `session/prompt` to settle. After 3 consecutive timed-out interrupts on the same turn, releases the host cleanly (process-group kill by recorded PID) so recovery adopts a fresh child.
  - `runtimeSteerCapability("antigravity")` returns `{ steer: false, steerMode: "interrupt" }`, so `structuredDeliveryQueue.ts`, `sendSettlement.ts`, `runtime-host/journal.ts`, and `message_receipt` automatically report `delivery: "interrupt-then-turn-started"` with `interruptedTurnId`, and never `steered`.
- **Automated sender policy:**
  - Following `docs/design/copilot-slices-2-4-plan.md` §5.4, automated senders targeting a busy Antigravity conversation (pipeline relays, seat ticks if ever routed, non-urgent agent messages) default to `policy: "queue"` unless explicitly interrupting, preventing spurious turn cancellations.
- **Resume & release:**
  - `AntigravityAcpHost.adopt(sessionId, options)` starts a fresh `agy acp` child, runs `initialize`, calls `session/resume { sessionId, cwd, mcpServers }` (zero replay noise), re-applies `model` and `thought_level` via `session/set_config_option`, appends `session.resume` to `events.jsonl`, and reconciles `RuntimeEventStore` cursor.
  - `release()` sends `session/close { sessionId }`, closes stdin, waits for graceful exit, and terminates the child process group strictly by recorded `ProcessIdentity` (`releaseIfOwned`). Never kills by process-name pattern.
  - Unknown agent→client JSON-RPC requests (`fs/*`, `terminal/*`, etc.) are answered immediately with JSON-RPC error `-32601` (`Method not found`) so the child never hangs waiting for an unadvertised client capability.
- **In-process live model/effort reconfiguration (`structuredReconfigure.ts`):**
  - When idle, model or effort reconfiguration calls `session/set_config_option` live (or restarts and resumes via `adopt` if the host is unhosted/dead), writes `session.model_change` to `events.jsonl`, and updates the durable launch profile. Account changes are refused with an explicit message (single-account v1).

### 3.4 Models, efforts, and role registry

- **`src/lib/agent/models.ts`:**
  - Widen `ENGINE_MODELS`, `listedModels`, `launchModelIds`, `validateLaunchModel`, `defaultModelFor`, and `modelDisplayName` to include `"antigravity"`.
  - Default launch model: `"gemini-4-neon"` (or `"gemini-4-neon-high"` normalized to base `gemini-4-neon` + effort `high`; curated list contains the measured `agy 1.5.13` models from §2.4).
  - `validateLaunchModel("antigravity", model)` accepts any catalog base model, any combined `<base>-<effort>` model ID from `agy models` (e.g. `gemini-4-neon-xhigh`), and any bounded lowercase token matching `/^[a-z0-9][a-z0-9._-]{0,127}$/` so newly released `agy` models work immediately without waiting for a code change; the CLI remains the final arbiter.
- **`src/lib/agent/efforts.ts`:**
  - Widen `AgentEngineName` to `"claude" | "codex" | "copilot" | "antigravity"`.
  - `ENGINE_EFFORTS.antigravity = ["low", "medium", "high", "xhigh", "max"]` (matching `agy --help`).
  - Per-model scales (`ANTIGRAVITY_MODEL_SCALES` + dynamic catalog overrides from ACP `configOptions` / `agy models`):
    - `gemini-4-neon`, `gemini-4-hydrogen`: `["low", "medium", "high", "xhigh"]`
    - `gemini-4-argon`, `gemini-3.8-flash`, `claude-opus-5-5`, `claude-sonnet-5-5`: `["low", "medium", "high"]`
    - `gpt-oss-120b-medium`: `["medium"]`
    - unknown/future models: `ENGINE_EFFORTS.antigravity` (`low`..`max`).
- **`src/lib/agent/antigravityModels.ts`:**
  - Parses `agy models` TSV output (`<modelId>\t<displayName>`) and ACP `session/new` `configOptions` + `models.availableModels` into `{ id, name, baseModel, efforts, combinedIds }`.
  - Persists per-account catalogs atomically at `statePath("antigravity-model-catalogs.json")` and always returns fresh copies to callers.
- **Role registry and pipeline stages (`src/lib/roles/`, `src/lib/pipelines/`):**
  - Widen `RoleEngine` (`src/lib/roles/types.ts:19`) to `"claude" | "codex" | "antigravity"` (leaving Copilot's deliberate slice-4 boundary untouched unless needed, or keeping clean explicit switches).
  - Update `src/lib/roles/store.ts` (`isPartialConfig`, `isCompatibleConfig`), `src/lib/roles/equivalents.ts` (`ROW_TARGETS`, `equivalentModel`), `src/lib/roles/costHints.ts`, `src/lib/accounts/engineConnection.ts` (`EngineName`, `engineReadiness`, `ENGINE_LABEL`), `src/lib/onboarding/healthCheck.ts`, `src/lib/onboarding/agentInstallCommands.ts`, `src/components/onboarding/AgentMappingTable.tsx`, `src/components/onboarding/EnginesStep.tsx`, and `src/components/onboarding/OnboardingDialog.tsx` so every role row and pipeline stage can select Antigravity, its models, and its efforts cleanly.
  - Widen `create_pipeline` stage engine validation (`src/lib/mcp/server.ts`, `src/lib/pipelines/engine.ts`) and `spawnCommand.ts` pipeline membership/adoption to admit `"antigravity"` stages (refusing with `ENGINE_NOT_CONNECTED` when `agy` is missing, never falling back to another engine).

### 3.5 Board rendering, scanner, and search (Slice 3)

- **Core unions (`src/lib/types.ts`):**
  - `RootKey`: add `"antigravity-sessions"`
  - `Engine`: add `"antigravity"`
  - `Fmt`: add `"antigravity"`
  - `TranscriptEngine`: add `"antigravity"`
- **Scanner (`src/lib/scanner/antigravityNative.ts` + scanner pipeline):**
  - Root layout: `<antigravityHome>/sessions/<sessionId>/events.jsonl` (only direct `<uuid>/events.jsonl` files are transcripts; any sibling files are ignored).
  - `antigravityHeadFromRecords`: reads `sessionId`, `cwd`, `model`, `effort`, `agyVersion`, `firstUserMessage`, `startedAt`.
  - `antigravityTurnState`: tracks `user.message` / `assistant.turn_start` / `tool.execution_start` / `tool.execution_complete` → `busy`; `assistant.turn_end` / `abort` / `session.quota_exhausted` / `session.error` / `session.shutdown` → `terminal`.
  - `antigravityStopReason`: extracts the terminal stop reason (quota exhaustion with reset time, or error message) for card status rendering.
  - `antigravityToolName`: normalizes `mcp_viewer_<tool>` → `mcp__viewer__<tool>` so Viewer MCP calls render identically to Claude/Codex/Copilot.
  - **Project / worktree grouping (`AGENTS.md` invariant):** `resolveProjectOverlay` routes `"antigravity-sessions"` through `projectInfoFromCwd(cwd, stateKey)` with persisted `projectInfoFromTranscript` fallback, so live and deleted worktrees group under their parent repository identically (`describe.test.ts` pins the deleted-worktree case).
  - Bump `FILE_SCAN_CACHE_SCHEMA_VERSION` from `12` to `13` in `src/lib/scanner/scanCache.ts` and widen validators in `scanCache.ts`, `projectCatalog.ts`, `conversationCatalog.ts`, and `resourceCollector.worker.ts`.
- **Feed rendering (`src/components/feed/parse.ts` + `tools.ts` + `FeedItem.tsx`):**
  - Add `renderAntigravity` beside `renderCopilot`:
    - `user.message` → `addUserText`
    - `assistant.message` → `addProse`
    - `tool.execution_start` → `registerCall(newToolEvent({ engine: "antigravity", tool: antigravityToolName(...), ... }))`
    - `tool.execution_complete` → `addOutput(toolCallId, output, isError, ...)`
    - `abort` → `push({ kind: "note", text: tr("render.turnInterrupted") })`
    - `session.quota_exhausted` → `push({ kind: "note", text: ... })` showing the quota exhaustion message and computed reset time so the card clearly shows why the agent stopped
    - `session.error` → `push({ kind: "note", text: ... })` showing the turn error stop reason
    - `session.start` / `session.resume` / `session.model_change` → `addSvc(...)`
- **Search and paged reading:**
  - `src/lib/session/reader.ts` + `src/lib/mcp/bindings.ts`: add `normalizeAntigravityLine` and `readAntigravity` so `conversation_messages` and `get_conversation` read Antigravity transcripts cleanly.
  - `src/lib/search/transcriptSearch.ts`: widen `engine` union and SQL `CHECK(engine IN ('claude', 'codex', 'copilot', 'antigravity'))`, bump `TRANSCRIPT_SEARCH_SCHEMA_VERSION` from `5` to `6` with safe transactional table migration (SQLite 3.39 compatible — no 3.42+ syntax!), and index `user.message` and `assistant.message` records for `search_transcripts`.
  - `src/lib/view/snapshot.ts`, `src/lib/view/compactText.ts`, `src/lib/timeline.ts`, `src/hooks/useSwitchboardData.ts`: admit `"antigravity"` so cards appear in waiting buckets, snapshots, and timelines.

### 3.6 Accounts, limits, and `RESOURCE_EXHAUSTED` quota reporting (Slice 4)

- **Account model (`src/lib/accounts/antigravity.ts`):**
  - Models the host's signed-in Antigravity CLI account as `id: "default"`, `label: "Default"`, `kind: "legacy"`, with `home: <config>/agent-log-viewer/accounts/antigravity/default`, `sessionsDir: <home>/sessions`.
  - Auth state checks CLI presence (`antigravityBinaryGap`) plus observed auth/tier metadata from the last ACP handshake (`antigravity-auth-state.json` under `statePath(...)`), never storing tokens or emails.
  - `AccountEngineName` widens to include `"antigravity"`; `AccountCatalog` gains optional `antigravity`.
- **Quota error parser (`src/lib/limits/antigravityQuota.ts`):**
  - Antigravity enforces a **5-hour (`300`-minute) rolling/reset quota window per Google account**.
  - Parses `RESOURCE_EXHAUSTED` error strings such as:
    - `"RESOURCE_EXHAUSTED: Individual quota reached ... Resets in 4h 12m 30s"`
    - `"Individual quota reached for <model>. Resets in 2h 15m"`
    - `"RESOURCE_EXHAUSTED ... Resets in 45m"` / `"Resets in 90s"`
    - Optional ISO-8601 reset timestamp if present in future CLI versions.
  - Pure parser `parseAntigravityQuotaError(message, observedAtMs)` computes:
    - `exhausted: true`
    - `resetsAt`: Unix seconds (`Math.floor((observedAtMs + durationMs) / 1000)`) or `null` if no duration/timestamp is present
    - `windowMinutes: 300` (5 hours)
    - `usedPercent: 100`
    - `observedAt`: Unix seconds
  - Maps directly onto `EngineLimits`:
    - `session: { usedPercent: 100, resetsAt, windowMinutes: 300, observedAt, source: "account" }` (while `now < resetsAt`; once `now >= resetsAt`, the stale exhaustion is no longer reported as 100% exhausted — it transitions to expired/unknown until a newer observation arrives)
    - `weekly: null`, `tiers: []`, `plan: tierName ?? null`, `capturedAt: observedAt`.
- **Quota observation & surfacing:**
  - When `AntigravityAcpHost.send()` catches a `session/prompt` error matching `parseAntigravityQuotaError(...)`:
    1. Writes `session.quota_exhausted` to `events.jsonl` (durable transcript evidence for the card stop reason and `readAntigravityTranscriptLimits`).
    2. Emits `{ kind: "limits", snapshot: { engine: "antigravity", exhausted: true, windowMinutes: 300, resetsAt, observedAt, message: redactedMessage } }` on the runtime event stream.
    3. Records the durable `QuotaObservation` at the owner (`agentRegistry().recordQuotaObservations` / `QuotaController`) with `limitReached: true` and `provenance: { source: "transcript", ... }` (no process spawn, identity write only).
  - `readAntigravityTranscriptLimits(sessionsDir, now)` (`src/lib/limits/antigravityTranscriptLimits.ts`) inspects at most the newest 5 `sessions/<id>/events.jsonl` backwards (bounded at 16 MiB per file, matching `copilotTranscriptLimits.ts`) for the newest `session.quota_exhausted` record whose `resetsAt` is still in the future (or most recent record with expired state).
  - Widen `QuotaEngine`, `QuotaController` (`productionProbe`), `LimitsPayload` (`antigravity`, `antigravityAccountId`, `provenance.antigravity`), `/api/limits`, MCP `account_limits`, and the limits footer / card stop-reason banner.

---

## 4. Slice plan (one proposal PR per slice)

Each slice is delivered on its own branch as a **proposal PR** (never self-merged or deployed).

### Slice 1 — Launch, models/effort, role registry, and pipeline stages

- **Deliverables:**
  1. `AntigravityAcpHost` core (`start`, `send`, `release`, `health`, `attach`, `sessionMaterializationEvidence`, host-written `events.jsonl`, stdio & HTTP MCP attachment, `_meta.antigravity.systemPrompt.append`, `session/set_config_option` for model & `thought_level`).
  2. `src/lib/agent/cli.ts`: `AgentEngine` + `"antigravity"`, `resolveAntigravityBinary`, `antigravityBinaryGap`; `Dockerfile`: `make_nsenter_shim agy '$HOME/.local/bin/agy'`.
  3. `src/lib/accounts/antigravity.ts` + `AccountEngineName` + `AccountManager` routing for the default Antigravity account.
  4. `src/lib/agent/models.ts`, `src/lib/agent/efforts.ts`, `src/lib/agent/antigravityModels.ts`: curated + dynamic `agy models` / ACP `configOptions` catalog, combined ID (`gemini-4-neon-xhigh`) and base+effort resolution, effort ladder `low`–`max`.
  5. Launch seams: `POST /api/spawn`, `src/lib/agent/spawnCommand.ts`, MCP `spawn_agent`, `src/lib/runtime/structuredSpawn.ts` (`startAntigravityStructuredHost`, `defaultStartHost`), `RuntimeHostKind` (`"antigravity-acp"`), `AgentRegistry` host kind validation.
  6. Role registry & pipeline stages: `RoleEngine`, `src/lib/roles/{store,equivalents,costHints}.ts`, `src/lib/accounts/engineConnection.ts`, `src/lib/pipelines/engine.ts` + MCP `create_pipeline` stage engine admission, and launch/role UI pickers (`AgentLaunchControls`, `AgentMappingTable`).
- **Verification:**
  - Scripted-ACP unit tests (`antigravityAcpHost.test.ts`), model/effort/role-store/pipeline tests, concurrent writer + second SQLite connection + caller-mutation tests.
  - Scratch Delegatus E2E check on a non-8898 port (e.g. `8899`) with isolated `HOME`/`XDG_CONFIG_HOME`/`LLV_STATE_DIR`/`TMPDIR`: spawn an `engine: "antigravity"` conversation via `POST /api/spawn` at `gemini-3.8-flash-low`, verify live completion and clean process teardown.

### Slice 2 — Conversation control through API (`/api/conversation-host`)

- **Deliverables:**
  1. `AntigravityAcpHost.interrupt` (`session/cancel` + 10 s bound + open-permission cancel + 3-strike host release), `answer` (`session/request_permission`), `adopt` (`session/resume` + re-applying `model`/`thought_level` `configOptions` + cursor restore), `reconfigure` (`session/set_config_option` / adopt fallback).
  2. `runtimeSteerCapability("antigravity") -> { steer: false, steerMode: "interrupt" }`, `structuredDeliveryQueue.ts` + `sendSettlement.ts` + `runtime-host/journal.ts` routing (`delivery: "interrupt-then-turn-started"`, `interruptedTurnId`, never `steered`).
  3. `/api/conversation-host` send, interrupt, kill, resume, and `message_receipt` end-to-end wiring, plus automated-sender `queue` policy for busy Antigravity conversations.
  4. `agentState` integration (`AgentFacts.engine`, `service.ts`, `startup.ts`, `startupSnapshot.ts`, `sqliteRegistryStore.ts`, `nativeTurnState.ts`).
- **Verification:**
  - Scripted-ACP tests for send, `stale-turn` refusal, cancel latency & `stopReason: "cancelled"`, 3-strike interrupt failure release, permission attention + answer, `adopt` via `session/resume` re-applying model/effort, concurrent queue writers, second SQLite connection reads, and mutated-copy safety.
  - Scratch Delegatus E2E check on port `8899`: spawn → send follow-up via `/api/conversation-host` → verify `message_receipt` → mid-turn send verifying `interrupt-then-turn-started` → kill → resume via `/api/conversation-host` and verify context preserved (`session/resume`).

### Slice 3 — Board rendering, scanner, and search

- **Deliverables:**
  1. `src/lib/types.ts` (`RootKey`, `Engine`, `Fmt`, `TranscriptEngine`), `src/lib/scanner/antigravityNative.ts`, `roots.ts`, `discover.ts`, `describe.ts` (with `projectInfoFromCwd` overlay), `activity.ts`, `model.ts`, `effort.ts`, `index.ts`, `scanCache.ts` (schema 12 → 13), `projectCatalog.ts`, `conversationCatalog.ts`, `resourceCollector.worker.ts`.
  2. `src/components/feed/parse.ts` (`renderAntigravity`), `tools.ts`, `FeedItem.tsx`, `utils.ts`, `scheme/offscreenClusters.ts`, `useSwitchboardData.ts`, `view/snapshot.ts`, `view/compactText.ts`, `timeline.ts`.
  3. `src/lib/session/reader.ts` (`normalizeAntigravityLine`, `readAntigravity`), `src/lib/mcp/bindings.ts` (`conversation_messages`, `get_conversation`), `src/lib/search/transcriptSearch.ts` (schema 5 → 6, SQLite 3.39 safe migration, `search_transcripts`).
- **Verification:**
  - Unit tests: `antigravityNative.test.ts`, `antigravity.parse.test.ts`, `describe.test.ts` (including **deleted worktree still groups under parent repo** per `AGENTS.md`), `reader.test.ts`, `transcriptSearch.test.ts` (including v5 → v6 migration, second SQLite connection, concurrent writer, caller mutation, and SQLite 3.39 compatibility via `minimumSqlite.preload.ts`).
  - Scratch Delegatus E2E check on port `8899`: spawn and run a tool-calling turn, scan and read back via `/api/files`, `conversation_messages`, and `search_transcripts`, verifying user message, assistant prose, normalized tool call/result, and search hit.

### Slice 4 — Accounts, limits, and `RESOURCE_EXHAUSTED` quota reporting

- **Deliverables:**
  1. `src/lib/limits/antigravityQuota.ts` (`parseAntigravityQuotaError`, `antigravityLimitsFromExhaustion`, 5-hour 300-minute window mapping).
  2. `src/lib/limits/antigravityTranscriptLimits.ts` (bounded reverse scan of newest 5 transcripts, 16 MiB cap).
  3. `AntigravityAcpHost` quota-error interception: write `session.quota_exhausted` record, emit `limits` `RuntimeEvent`, record durable `QuotaObservation` by identity.
  4. `QuotaEngine`, `QuotaController`, `src/lib/limits.ts` (`LimitsPayload`), `/api/limits`, MCP `account_limits` (+ `schemaParity.test.ts`), limits footer row, and card stop-reason display (`session.quota_exhausted` / `session.error` rendered clearly on the card).
- **Verification:**
  - Unit tests: `antigravityQuota.test.ts` (all `"Resets in ..."` formats, expiry after `resetsAt`, non-quota errors untouched), `antigravityTranscriptLimits.test.ts` (bounded reverse read, truncated trailing line, concurrent writer, second SQLite connection, caller mutation), `antigravityAcpHost.test.ts` (scripted `RESOURCE_EXHAUSTED` error emits `limits` event + writes `session.quota_exhausted`), `quotaController.test.ts`, `schemaParity.test.ts`.
  - Scratch Delegatus E2E check on port `8899`: exercise quota-exhaustion reporting through `/api/limits` and card rendering on a scratch conversation.

---

## 5. Deferred — explicitly out of scope for this batch

| Item | Reason deferred | Revisit trigger |
|---|---|---|
| **Read-only detection of external `agy` sessions** (e.g. started in tmux outside Delegatus) | External `agy` writes only protobuf SQLite tables (`~/.gemini/antigravity-cli/conversations/<id>.db`) with unpublished binary schemas (`steps`, `trajectory_metadata_blob`). Delegatus-launched sessions use our clean host-written `events.jsonl` instead. | Upstream `agy` exposes a stable JSONL export or documented read API, or a dedicated read-only protobuf decoder task is scoped. |
| **Multi-account Google OAuth switching** | Probing `agy 1.5.13` showed Google OAuth credentials resolve to the host's signed-in account even when `HOME` and `XDG_*` are redirected; `agy` does not expose a per-home credential directory equivalent to `COPILOT_HOME` or `CODEX_HOME`. | Upstream `agy` adds isolated per-profile OAuth storage or explicit credential-directory flags. |
| **`agy remote-control` and `--remote-agent`** | Requires a separate background daemon and remote project lifecycle unrelated to local structured-host execution. | Operator requests remote Antigravity project hosting. |
| **`agy --sandbox` OS restrictions** | Delegatus already enforces process-group, memory-cell, and workspace boundaries; CLI sandbox interaction with ACP MCP servers is unmeasured. | Explicitly scoped security task. |
| **Orchestrator seat hosting on Antigravity** | Needs full seat-tick, handoff-digest, and context-window validation after Slices 1–4 run in production. | Follow-up PR after Slices 1–4 are reviewed and merged. |
| **Live reasoning (`agent_thought_chunk`) streaming** | `agy 1.5.13` reports `usage.thoughtTokens` on turn completion but emitted zero `agent_thought_chunk` notifications during probes. | A future `agy` release emits `agent_thought_chunk` over ACP (our tolerant transcript/feed parser can display it trivially when it appears). |

---

## 6. Risks and mitigations

1. **P1 — Unadvertised ACP server→client requests can wedge a turn.** Mitigation: reply `-32601` immediately to any agent→client JSON-RPC request outside `session/request_permission`, and enforce request timeouts + turn-silence recovery.
2. **P1 — `session/resume` resets model and effort to account default.** Mitigation: always invoke `session/set_config_option` for `model` and `thought_level` on both `start` and `adopt`, pinned by unit and E2E tests.
3. **P1 — `RESOURCE_EXHAUSTED` message phrasing could vary across `agy` releases.** Mitigation: match both explicit `RESOURCE_EXHAUSTED` / `"Individual quota reached"` signatures and parse flexible duration tokens (`Xh`, `Xm`, `Xs`, plus ISO timestamps), retaining the redacted error message on the card stop reason even when no duration can be parsed.
4. **P2 — Two-engine ternaries (`engine === "claude" ? A : B`) silently misroute a new engine.** Mitigation: audit every touched file with `rg` for two-engine ternaries and explicit `"claude" | "codex"` unions before each slice PR.
5. **P2 — SQLite 3.39 compatibility on macOS.** Mitigation: test every SQL change (especially `transcriptSearch.ts` v5 → v6 migration) with `--preload ./src/lib/state/minimumSqlite.preload.ts`.
6. **P2 — Privacy leaks from `agy` output.** Mitigation: never log or persist `agy` banner text, account emails, or absolute home paths; run `bun scripts/privacy-publication-gate.ts --require-known-values --check-commits --base origin/main` before every push.
