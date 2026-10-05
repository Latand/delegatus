# Codex native sub-agent permission audit

## What was found

A read-only local snapshot taken on 2026-10-05 confirmed **705 native
`spawn_agent` calls in 220 conversations launched with `allowSubagents=false`**.
All matching native session headers recorded **Codex CLI 0.159.3**. The calls
used the v2 argument contract (`task_name` and `message`). Native child headers
independently confirmed **703 children** of those denied parents through
`session_meta.payload.source.subagent.thread_spawn.parent_thread_id`.

The old launch policy disabled `multi_agent` alone. Codex gives an enabled
`multi_agent_v2` feature precedence over `agents.enabled`, and otherwise uses
model metadata to select v2 when `agents.enabled` remains true. Consequently,
even a false `multi_agent_v2` flag does not prohibit model-selected v2. Both
0.159.3 and 0.160.0 have this precedence. Denial requires **both feature flags
off and `agents.enabled=false`**.

An explicit `approvals_reviewer="auto_review"` is another route: the
synchronous Guardian router selects its reviewer for on-request/granular
approvals independently of `guardian_approval` and `guardianv2`. A native
`config/read` regression confirmed that disabling those features alone retained
`auto_review`. Denied launches therefore also select `approvals_reviewer="user"`
at process and thread boundaries. A grant preserves the configured reviewer.
A follow-up read-only search across 868 available denied parent artifacts found
zero native `guardian_assessment` events and zero malformed rows. The reviewer
route is configuration/source evidence; it supplied no observed activity count.

| UTC date | Native `spawn_agent` calls | Matching child headers |
|---|---:|---:|
| 2026-10-01 | 129 | 129 |
| 2026-10-02 | 403 | 402 |
| 2026-10-03 | 121 | 121 |
| 2026-10-04 | 43 | 42 |
| 2026-10-05 | 9 | 9 |
| Total | 705 | 703 |

The audit joined explicit denied launch receipts to their conversations and
generation artifacts, then searched the native JSONL tool records and child
headers. It read the registry through SQLite `mode=ro`; it imported no product
stores and changed no transcripts. There were 876 denied Codex receipts
(869 completed, six failed, one path-pending), 844 available receipt-backed
conversation artifacts, and 1,840 native headers in the child search. Calls
before the earliest denied launch admission were excluded. No malformed rows
were encountered. This is an available-artifact snapshot; missing artifacts
and the two unmatched calls provide no child-completion evidence.

A later read-only cross-check during publication reached **714 `spawn_agent`
calls in 224 denied conversations**, with **712 matching child headers** among
1,860 headers. Its receipt inventory contained 886 denied launches and 855
available parent artifacts. All 714 inspected argument objects used the v2
contract; no matching child predates denied admission. Only the 2026-10-05 row
grew, to 18 calls and 18 matching headers. Both snapshots recorded 0.159.3.

The exact observed method was `spawn_agent`, recorded as a native
`response_item` / `function_call`. Searches also covered `collabAgentToolCall`,
`subAgentActivity`, and other spawning calls. Those two app-server item types
were absent from these native transcript records. No conversation text,
identities, transcript identifiers, or project names are published here.

## Enumerated surfaces

Both interpreters were inspected with `--version`, `features list`, CLI help,
and `app-server generate-json-schema --experimental`, plus their tagged source.
The installed interpreter was left at 0.159.3. A standalone 0.160.0 executable
was extracted into private scratch storage for comparison. The repository's
[method catalog](codex-api-update/METHOD-CATALOG.md) describes 0.153.4; fresh
schema enumeration found **262 request and notification method names** in each
audited interpreter, with identical sets.

| Surface | How it creates or reaches agents/threads | Old denied policy | Denied policy after this change |
|---|---|---|---|
| Native v1 model tools | `spawn_agent` creates; `resume_agent`, `send_input`, `wait_agent`, `close_agent` manage children | Feature-selected v1 disabled | `agents.enabled=false`, `multi_agent=false`, `multi_agent_v2=false` |
| Native v2 model tools | `collaboration.spawn_agent` creates; `followup_task` can restart work; `send_message`, `wait_agent`, `interrupt_agent`, `list_agents` operate on children | Explicit or model-selected v2 remained available | Same three-part denial removes the entire collaboration tool family |
| Code Mode and deferred model tools | Alternate packaging and discovery of the same native collaboration tools | Inherited the v2 gap | Tool construction receives the denied multi-agent version regardless of packaging |
| Guardian review agents | `guardianv2` controls asynchronous reviews; explicit `approvals_reviewer="auto_review"` routes synchronous approvals independently of feature flags | Both routes remained configurable | All active Guardian flags default off and the reviewer is explicitly `user` |
| Memory background agents | `memories` enables internal memory work; `external_agent_memory_import` is associated support | User configuration could enable them | Both default off |
| Agent coordination and worktree support | `agent_message_board`, `defer_mailbox_preemption`, `use_agent_identity`, `worktrees` support agent workflows | Unclassified | Default off |
| Removed compatibility flags | `enable_fanout`, `multi_agent_mode`, `collaboration_modes`, `send_async_message` | No active tool route found | Explicitly classified as removed/inert by the CLI inventory |
| Shared terminal daemon | `daemon_auto_start`; an existing daemon can carry configuration from another launch | No launch-local daemon fence | Terminal fresh/resume uses `--no-daemon` where supported; the feature is disabled |
| App-server controller RPCs | `thread/start` creates a root; `thread/fork` creates another thread; `review/start` may start a detached review; `thread/resume` reloads an existing thread | Available to the controller, outside model-tool routing | Delegatus-owned host process and each started/resumed thread receive denial; controller entrypoints remain available for authorized work |
| Existing-thread background work | `thread/queue/start`, `turn/start`, `thread/realtime/start`, `thread/compact/start` operate on an existing thread; `thread/backgroundTerminals/*` manages shell terminals | Available; these methods do not themselves expose native child delegation | Thread policy stays denied; ordinary in-thread work remains available |
| Separate clients and cloud tasks | `codex`, `exec`, `review`, `fork`, `agents`, remote app-server clients, and `codex cloud exec` (including multiple `--attempts`) are independent client entrypoints | Reachable through an unrestricted shell or another controller | Outside native tool permission; launching a separate credentialed client requires its own authorization and policy |
| Apps, plugins and dynamic/MCP tools | Extensions can invoke external services; Delegatus `spawn_agent` uses its separate tracked permission/lineage contract | Existing connector and plugin grants | Apps and unreviewed extension features default off; an explicit approved plugin grant remains separate |

The enforcement boundary is the native tools and background agent features of
the interpreter Delegatus launches. A process with unrestricted shell access
can run another executable or contact a remote service with credentials. Native
feature configuration cannot impose an operating-system ban on that process.
This change does not claim such isolation or prohibit the separately authorized
Delegatus spawning tool. No real agent or cloud task was launched to investigate
these independent client entrypoints.

## Enforcement in all launch paths

`src/lib/agent/codexSpawnPolicy.ts` owns a reviewed allowlist of features that
perform ordinary work within one agent. Every active feature reported by the
**exact launch binary** outside that allowlist is disabled, regardless of its
name, default, or maturity. Removed features are classified as inert. New
features therefore default off without requiring an agent-related name match.
An empty, failed, duplicate, incomplete, or unrecognized inventory refuses the
denied launch. Discovery uses isolated configuration and no model turn. Docker
host-namespace shims retain the binary-selection home while using a fresh
configuration directory on the shared mount.

| Launch path | Process policy | Thread policy and permission-enabled behavior |
|---|---|---|
| Terminal CLI, fresh and resume | `-c agents.enabled=false`, `-c approvals_reviewer="user"`, `--disable` for every reported unapproved feature, and `--no-daemon` where supported | A grant sets `agents.enabled=true`, keeps configured native features/reviewer, and uses its own daemon |
| Headless `exec` reviewer | Same discovered denial before `exec --ignore-user-config` | This reviewer surface always denies native delegation |
| App-server host, fresh and adopted | `-c agents.enabled=false`, `-c approvals_reviewer="user"`, and `-c features.<name>=false` for every unapproved feature before `app-server` starts | Both `thread/start` and `thread/resume` receive the denied settings, the complete discovered false feature map, and explicit `approvalsReviewer: "user"`; a grant sets `agents.enabled=true` and `multi_agent=true`, preserving configured v2/reviewer |

The per-thread feature table can replace the process table. Applying the entire
denial at both levels prevents that replacement from reopening a background
feature. The existing explicit approved-plugin grant remains honored at both
levels. Older interpreters receive CLI `--disable` flags only for features they
report, avoiding rejection of a newer unknown flag.
The reviewed `computer_use` feature permits ordinary interaction by the current
agent; the existing plugin allowlist still controls whether its tools are
granted. Browser-agent integrations and local-automation features remain off.

## Detection and existing visibility

Native `collabAgentToolCall` and `subAgentActivity` items in the app-server
durable event ledger are checked before the runtime producer cursor advances.
Native `item/autoApprovalReview/*` notifications are projected into that same
ledger using their review identifier and a fixed type, discarding the action
contents. Native `guardian_assessment` transcript events also feed detection.
Journal contention retries the same item. Scanner controller ticks also inspect
authoritative native child headers, covering terminal CLI, headless exec, and
missed live parent events. A fork-only header provides no child evidence.
Historical child creation before denied launch admission is excluded.
Typed native calls in each denied parent's bounded transcript tail also alert
when no child materializes. Unchanged tails are cached; one tick reads at most
8 MiB across parents, continuing other candidates on subsequent ticks. Child
headers and the durable app-server ledger cover activity outside that tail.

A violation requires the exact parent generation to deny sub-agents and an
explicit denied Delegatus launch receipt for its artifact. Imported standalone
sessions with a default false profile produce no false alert. The most recent
receipt at the activity's timestamp must deny delegation; child history from a
permission-enabled interval stays clear. A violation appends
`subagent_policy_violation` to the existing durable lifecycle journal, visible
through `lifecycle_events` query and its immediate high-signal digest. Stable
native-item/child keys deduplicate replay and survive restarts. Summaries contain
only a fixed method label; native prompts and child results are discarded.
Detection adds no controls and does not alter the agent's execution state.

## Newer CLI delta

The newest published stable CLI checked on 2026-10-05 was
[0.160.0](https://github.com/openai/codex/releases/tag/rust-v0.160.0), released
2026-10-01. Its feature inventory has 154 entries versus 152 in 0.159.3. The only
additions are `guardian_conversation_history_tools` and
`guardian_root_handoff_context`, both under development and false by default.
This policy disables both automatically. No existing feature row or app-server
method-name set changed. The model-selected v2 precedence and the six native
v2 collaboration tools remain present; upgrading alone does not close the gap.
The installed CLI was not updated.

Primary implementation evidence:

- [0.159.3 configuration precedence](https://github.com/openai/codex/blob/rust-v0.159.3/codex-rs/core/src/config/mod.rs)
- [0.160.0 configuration precedence](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/config/mod.rs)
- [0.160.0 model tool construction](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/tools/spec_plan.rs)
- [0.160.0 native collaboration contracts](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)
- [0.160.0 feature inventory](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/features/src/lib.rs)
- [0.160.0 CLI entrypoints](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/cli/src/lib.rs)
- [0.160.0 cloud tasks](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/cloud-tasks/src/lib.rs)
- [0.159.3 synchronous Guardian routing](https://github.com/openai/codex/blob/rust-v0.159.3/codex-rs/ext/guardian-reviewer/src/routing.rs)
- [0.160.0 synchronous Guardian routing](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/ext/guardian-reviewer/src/routing.rs)

## Verification

The committed native router regression uses the real interpreter and a local
credential-free Responses fixture whose synthetic model selects v2. It returns
one final message and executes no tools. In both 0.159.3 and 0.160.0, the old
policy exposed all six collaboration tools, the denied policy exposed zero,
and the grant exposed all six. Ordinary `exec_command` remained available.
There were **zero real sub-agent probes on operator accounts**.
The native configuration regression calls only `initialize` and `config/read`
under an isolated home. With Guardian feature flags false and an explicit
`auto_review` account setting, the pre-fix interpreter configuration retained
that reviewer. Denial now resolves it to `user`; a grant retains `auto_review`.
This check creates no thread, executes no tools, and runs on both interpreters.

A separate base regression ran the actual pre-change headless configuration
function and failed its three-part denial assertion. The corresponding head
test passes. The installed-inventory test reads `codex features list`, checks
every agent-related feature is disabled, explicitly allowed, or removed, and
feeds the emitted flags back through the native parser. Unknown-feature tests
cover unrelated spellings and both true and false defaults.
The permission-history regression also failed before the detection correction
and passes when it selects the receipt active at the child's creation time.

Focused checks run each exact file in a separate process with isolated
`LLV_STATE_DIR`, `HOME`, `TMPDIR`, and configuration under the OS temporary
root, plus `LLV_VIEWER_CONTROL_URL` on a closed port:

- `src/lib/agent/codexSpawnPolicy.test.ts` (installed CLI and standalone newer CLI)
- `src/lib/agent/cli.test.ts`
- `src/lib/flows/exec.test.ts`
- `src/lib/codexHeadlessConfig.test.ts`
- `src/lib/runtime/codexAppServerHost.test.ts`
- `src/lib/runtime/codexAppServerHost.pluginGrant.test.ts`
- `src/lib/runtime/codexSubagentDetection.test.ts`
- `src/lib/runtime/structuredDeliveryController.test.ts`
- `src/lib/scanner/links.test.ts`
- `src/lib/lifecycle/digest.test.ts`
- `src/lib/lifecycle/journal.test.ts`
- `src/lib/mcp/voiceUtteranceWiring.test.ts`

Heavy commands use `scripts/gate-slot.sh`. Type checking and changed-file lint
are also run. Publication uses the repository's local pre-commit and pre-push
gates. Hosted CI is left to run after publication; this lane does not wait for
it, merge, deploy, or update the installed interpreter.
The native compatibility harness also pins the closed control URL. Its existing
voice HTTP fixture now overrides that URL with its own port-0 stub and restores
it after each case. With the closed URL, the original fixture failed seven of
eight tests; the corrected fixture passes all eight.
The unchanged 25 MiB replay fixture exceeded its original 30-second test limit
in a combined pinned-runtime run. Exact-case isolation passed on both base
(22.2 seconds) and head (25.3 seconds). Its test-only deadline is now 60 seconds
to accommodate concurrent gates; the replay assertions remain unchanged.
