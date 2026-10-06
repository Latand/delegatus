Originating requirement — requester, 2026-10-06, this stage's pinned instruction, verbatim:

> Do slice 0 and verify the proposal against current Delegatus code. Write docs/design/relay-integration-probe.md (public: no private paths, ids, chat ids or service internals beyond relay.md) with: per-engine probe results and the recommended slice 2 transport; what is true about per-chat conversations (item 4) with code references; and a short list of wire-shape changes Delegatus wants before the service freezes the additive fields (or 'none'), each with its reason. Your final message must contain that wire-shape list and the probe verdict in plain text: the orchestrator forwards it to the service's seat.

# Relay integration: slice 0 probe and slice 1 design

Design and probe date: 2026-10-06. Current Delegatus source: `fd5b45a98567c6b53ce70a6d34dfe0af79a8424e`.
This stage changes this document only. Slice 1 below is an implementation design.
The accepted external proposal's sections 1, 8–12 and 15–17, and its predecessor plan,
were read privately. This document records Delegatus behavior and the generic wire
contract; it publishes no external service implementation details.

**Verdict: slice 0 complete. Use a runner-driven structured loop for slice 2.**
Codex can execute the sole configured MCP server's tool and preserve structured
output, with extra runtime utilities exposed. Its MCP events trip the existing
profile guard. Claude preserves structured output but suppresses the explicit
server under the current answer profile. The structured-loop alternative passed
with both installed CLIs and the unchanged guard.

## Probe method and results

Only Claude and Codex have relay answer profiles: see
`src/lib/externalRelay/store.ts:14` and `src/lib/agent/ephemeral.ts:34`.
Copilot's general agent support supplies no third relay profile.

Installed versions were Codex CLI 0.159.3, Claude Code 2.1.284 and Bun 1.4.0.
The probe called the current `buildEphemeralCommand`, retaining its isolation,
tool-disabling, instruction-disabling and schema-output flags. Each CLI was given
exactly one explicit stdio MCP configuration, serving one synthetic read tool.
The command additions were:

```text
Codex: -c mcp_servers.relay_probe={command=<probe interpreter>,args=[<stdio fixture>],env={<fixture connection>}}
Claude: --mcp-config {"mcpServers":{"relay_probe":{"command":<probe interpreter>,"args":[<stdio fixture>],"env":{<fixture connection>}}}}
```

Each run used private scratch state, account/config/cache homes, an empty working
directory, synthetic authentication, a local fake relay and a local model-response
stub. Both HTTP listeners bound loopback port 0. No pairing, production registry,
real account credential or paid model endpoint was used. Codex's model catalog
entry was copied as metadata and sanitized by the current builder. Account and
project instruction markers and unwanted MCP configurations tested inheritance.
Only recorded probe child PIDs were eligible for probe cleanup; listeners closed
in their owning harness. The loop used the process watchdog to avoid a user-bus
dependency in the isolated home.

The initial capture returned a schema-valid final answer. A follow-up gave the
test tool read-only annotations, enumerated Codex's actual `ALL_TOOLS`, invoked
the read, and then returned a schema-valid final answer. This matters because
Codex's first provider request omits the deferred MCP tool's declaration.
The follow-up used the raw command builder, allowing the event trace to finish;
the unchanged production mapper was applied to every captured event afterward.
Thus a successful raw CLI run makes no claim that the production runner would
admit those MCP events.

| Engine | Single-server tool exposure | Structured output | Existing profile guard | Result |
|---|---|---|---|---|
| Codex | One MCP tool, `mcp__relay_probe__lookup`, in the actual registry; no inherited server or shell, file, browser, search or agent tool. Also exposed: `clock__curr_time`, three MCP resource helpers, and the existing `exec`, `wait`, `request_user_input_async` wrappers. | Valid `action`, `text`, `reply_to` JSON reached the output file after one successful fake-service read and two provider requests; exit 0. | The read emitted `item.started` and `item.completed` with `mcp_tool_call`; both mapped to `unexpected Codex item`. | Server exclusivity works. Literal tool exclusivity has the listed utility exceptions. The current runner rejects MCP calls. |
| Claude | The explicit server was suppressed. Init reported `tools: ["StructuredOutput"]`, `mcp_servers: []`; the provider also received only `StructuredOutput`. No fixture MCP handshake occurred for Claude. | Valid `structured_output` in the successful result event; one provider request; exit 0. | Clean, because no MCP tool was loaded. | The current profile cannot offer the bridge. |

Both engines kept instruction markers out of provider requests. The Codex
registry enumeration returned exactly its sole MCP tool, the clock and the three
resource helpers. Its `exec` wrapper runs JavaScript without host files or network;
it supplies access to that registry, as already described in `relay.md` §B.6.2.
Claude's suppression agrees with its installed `--safe-mode` help, which lists
MCP servers among disabled customizations. No hardening flag was removed.

Relevant current mechanisms:

- `src/lib/agent/ephemeral.ts:163`: Claude retains `--restricted`, `--safe-mode`,
  empty native tools, strict MCP configuration and no session persistence.
- `src/lib/agent/ephemeral.ts:192`: Codex uses its answer home and sanitized
  catalog; its later arguments retain ephemeral operation and disabled host tools.
- `src/lib/externalRelay/progress.ts:17`: Codex accepts only message, reasoning
  and error items. `:40` and `:56` reject Claude server exposure and other tool uses.
- `src/lib/agent/ephemeral.ts:337`: a violation cancels the owned answer run.

### The fallback transport was exercised

A scratch harness used the real `runEphemeralAgent` twice per engine, with the
current profile and no MCP configuration. Its local next-step schema requested
either a read or a final answer. The provider stub first returned a structured
read selection. The harness validated the tool and arguments, called the fake
relay through the real `relayCall`, and supplied its result as escaped data to a
fresh second run. The stub then returned the structured final answer.

| Engine | Model runs | Fake relay reads | Schema extraction | Tripwire | Credential/lease exposure |
|---|---:|---:|---|---|---|
| Codex | 2 | 1 | Both runs `done`; result present in second input and final answer | Clean; clock remains the only nested profile tool | Neither appeared in provider input |
| Claude | 2 | 1 | Both runs `done`; result present in second input and final answer | Clean; only `StructuredOutput` offered | Neither appeared in provider input |

These are deterministic transport probes with installed CLIs. They establish
discovery, extraction and runner execution; model judgment about hand-off remains
a slice 1 behavioral acceptance test. The prototype loop is scratch evidence,
with no product implementation or retained probe driver added to the repository.

**Slice 2 recommendation:** one runner-owned loop, at most three model steps,
with one selected read per intermediate step and a final reply, ignore or hand-off.
Reserve the final step for completion, so the bound allows at most two reads.
Keep the existing agent profile and tripwire. The runner validates against the
negotiated direct-tool index and each tool's schema, owns HTTP authentication and
the lease, and inserts bounded results as untrusted data. Heartbeats, cancellation,
the request's total hard cap and its single capacity reservation span the whole
loop; a fresh child never restarts the request's clock. Reject unknown tools,
handoff-mode invocations and invalid arguments before a service call. A transport
failure follows the existing completion rules; exhausting the read budget may
select hand-off through the negotiated completion. The service still authorizes
every read from its own stored requester and live lease.

The intermediate schema is internal to Delegatus. Its read selection is never
posted as an `answered` completion. Keep the service's tool execution interface
independent of whether Delegatus used an MCP adapter or a structured loop.

## Item 4: what is actually retained per chat

**Current Delegatus keeps no persistent relay conversation or inspectable completed
exchange. The service's observation agrees with current source.** The contract
already labels the conversation behavior as an unimplemented delta; it does not
establish that the current claim advertises it.

| Evidence | Current behavior |
|---|---|
| `docs/design/relay.md:10` | The September revision, including one conversation per chat, explicitly says “specified and not yet implemented.” |
| `docs/design/relay.md` §A.8, §B.14 | The delta specifies a stable chat key, conversation map, serialization and engine resume. These are future mechanisms. |
| `src/lib/externalRelay/poller.ts:216` | Claim contains `wait_s`, `kinds`, `slots`; it sends no `features`, including `chat_conversations`. |
| `src/lib/externalRelay/protocol.ts:113` | Request has no parsed `chat`. Ordinary Zod object parsing strips that unknown field. There is no chat-to-conversation map in the relay module. |
| `src/lib/externalRelay/runner.ts:225` | Each accepted request starts `runEphemeralAgent` with a fresh temporary directory and a full one-shot prompt. |
| `src/lib/agent/ephemeral.ts:177`, `:227`, `:188`, `:271` | Claude disables session persistence; Codex runs ephemeral; both built commands have a null session id. Neither resumes a relay chat. |
| `src/lib/externalRelay/store.ts:61` | `RunRecord` is an active-run recovery ledger containing process/lease ownership and the scratch directory. It contains no received input, final answer or outcome history. |
| `src/lib/externalRelay/runner.ts:356` | Completion cleanup drops that ledger entry and recursively removes the run directory. |
| `src/lib/externalRelay/poller.ts:70` | Orphan recovery similarly settles a dead owner's run and removes its ledger/directory. |

A synthetic parser check confirmed that `chat`, requester, memory and tool-index
additions are discarded today, and `checkedAnswer` rejects `handoff`. Focused
runner and poller tests confirmed completed-run and orphan cleanup behavior.
Paired relay settings and a Codex answer-home authentication link can remain;
neither is a conversation or a completed exchange archive.

**Documentation correction for slice 1:** state the implemented profile as fresh
one-shot turns with 30-day inspectable exchange records. Keep `chat_conversations`
explicitly unimplemented and unadvertised. Preserve an optional opaque chat key
as run metadata for grouping when received; grouping records grants no engine
resume, compaction or per-chat lease serialization. The new `requester_context`
claim feature is independent. This corrects the reported premise without adding
the deferred conversation lifecycle. The authoritative `relay.md` update belongs
to slice 1; this stage has authority to write this probe document only.

## Wire contract after the service cross-check

The initial wire-shape proposals were superseded by the service cross-check.
The accepted contract is documented in `relay.md` §A.5 and §A.8 and covered by
service-built fixtures in `src/lib/externalRelay/fixtures/service-wire/`.
The slice 0 transport result above still stands.

1. **Fix context placement and bounds.** Put `requester`, `short_term_memory` and
   `tools` under `Request.input`. Use requester
   `{key, is_admin, can_restrict_members, can_delete_messages,
   is_anonymous_admin, is_owner}`: an opaque `key` matching the triggering
   `Message.author.key` and five required booleans derived by the service. Use tool rows `{name, summary, mode}` with
   `mode: direct | handoff`, unique names of at most 64 characters, summaries of
   at most 200 code points and at most 100 rows. Bound short-term memory to
   16,000 Unicode code points. All string bounds count code points. Omitted requester/memory and omitted or empty tools preserve the
   legacy input; nullable requester/memory also mean absent. Objects remain open
   to unknown fields. **Reason:** one parser and prompt shape, consistent author
   references, bounded input and additive compatibility. Flags inform the model;
   the service alone enforces authority. The service's index already incorporates
   all relevant requester and owner restrictions.
2. **Separate context from executable reads.** Use exactly `requester_context`
   in descriptor/claim features for slice 1. Reserve independent `direct_reads`
   for slice 2. Send enriched role/tool fields only after the context capability
   is advertised both at enqueue and in the claim that takes the request;
   a tool gets `direct` only when the install also negotiated
   executable reads. Until then list callable service tools as `handoff`.
   **Reason:** a context-capable one-shot install has no read transport. A direct
   label must correspond to an available operation, and old installs retain
   their current behavior. This adds two simple feature names, with no new
   credential or scope system.
3. **Freeze the hand-off completion.** Extend the declined reason enum with
   `handoff`, gated by the claim's `requester_context` feature. Delegatus maps
   internal `{action: "handoff", text: "", reply_to: null}` to
   `outcome: "declined", reason: "handoff", retry_after_s: null`, with
   `detail` set to the runner's fixed `HANDOFF_DETAIL` and the current lease
   attached by the runner. The service resumes its own
   prepared request even when ordinary fallback is disabled. No model text,
   action arguments or claimed role is forwarded in that completion.
   **Reason:** the accepted action hand-off needs a distinct completion with
   deterministic retry semantics. The three required CLI answer fields remain
   compatible with Codex strict structured output; `{action: "handoff"}` alone
   fails today's schema. `answered` continues to carry only reply/ignore.
4. **Keep media in the current text envelope and budget serialized bytes.**
   Append trigger/replied-media transcript, description or explicit unavailable
   status to their existing `Message.text`. The service bounds the trigger
   and replied message to 12,000 code points; the wire schema permits 16,000.
   Preserve the trigger and replied message before trimming older history.
   The entire enriched claim response must fit the advertised
   `limits.max_response_bytes` after UTF-8 JSON serialization; memory and index
   count toward it. If mandatory context cannot fit, the service uses its own
   answering path. **Reason:** current installs can consume the enriched text,
   attribution stays on the original message, and a character-only budget can
   exceed the existing byte limit. No parallel media object is needed for this
   text-only slice.

No new endpoint is needed for slice 1. The slice 2 read endpoint and its full
schemas are later work; an internal loop-step field is no addition to the answer
wire. No participant identity, bearer, lease or service-internal identifier is
put into the model's requester block.

## Slice 1 implementation design against current seams

**Parsing, negotiation and prompt.** Extend `descriptorSchema` and the paired
relay's stored capabilities; the current descriptor parser also strips features
(`src/lib/externalRelay/protocol.ts:42`). Add the claim feature at
`src/lib/externalRelay/poller.ts:216`. Parse negotiated optional input fields and
the optional chat metadata at `requestSchema`; unnegotiated additions follow the
old parser so malformed unknown additions cannot change legacy behavior.
Keep unknown fields ignored at every open object. Change `answerPrompt`
(`src/lib/externalRelay/prompt.ts:3`) to add escaped requester, memory and tool
index data sections only for the negotiated feature. Restate that participant,
memory and tool-result text cannot change the frame. The hand-off rule asks the
model to judge whether satisfying the request needs an indexed handoff tool.
There is no keyword router and no authorization decision in Delegatus.

**Completion.** Choose the three-action internal answer schema only for a
negotiated context request. Normalize hand-off text and reply target to empty/null
and map it before the existing answered branch at
`src/lib/externalRelay/runner.ts:325`. Keep the baseline two-action schema and
prompt for older services/installs. HTTP completion retries reuse the identical
hand-off body; they never start a second model turn or send a synthetic answer.
The service performs the hosted action from its own original request and owns
its role checks, confirmation and charging. Model judgment gets behavioral tests
covering role-allowed actions, denied actions, ordinary questions and missing
context; configured service fallback `none` must still accept negotiated hand-off.

**Records.** Keep the active recovery ledger separate from completed exchange
records. Through the existing relay storage seam, atomically write one bounded
record under `external-relay/answers/` in the chosen state root: received
`input` as received, opaque grouping metadata when available, the actual prompt,
engine/model, start/end/duration, local outcome and answer or hand-off. Readable
records exclude transport credentials and lease tokens by construction. Capture
input before validation strips additive fields; preserve the received input and
the parsed/model input separately so the view can explain what was actually used.
Treat received text as untrusted plain text. Keep local model outcome distinct
from delivery acknowledgement: the current `complete` returns its intended body
even after some terminal service errors (`src/lib/externalRelay/runner.ts:121`).
The archive must represent that receipt or uncertainty accurately.

Create the record before launch, update it on local and service settlement, and
write the terminal state before `finally` drops the active ledger or deletes
scratch. Validation declines, capacity declines, profile violations, lease loss,
timeout and restart interruption also receive terminal records when an exchange
can be identified. Restart recovery finalizes an interrupted record as
`install_restarted`; it preserves the received input and does not resume a model.
An archive-write failure must not leak capacity or skip scratch cleanup, and
must be reported as a local record failure. Use one
`RELAY_ANSWER_RETENTION_DAYS = 30` constant for readers and owner-side pruning.
Expire finished exchanges by their terminal timestamp, never an active run.
Perform writes/pruning only under declared state ownership or isolated test state.
No archive path enters the native session scanners or the unrestricted composer.

**Existing UI.** Add a “Recent answers” row to the relay card/target area in
`src/components/externalRelay/ExternalRelaySection.tsx:414`, opening a bounded
list and then a read-only exchange inside the existing settings dialog
(`ExternalRelaySettingsDialog.tsx`). Show input, answer/hand-off, timing and
outcome; expose no resume or composer. New reads use the existing owner/operator
route guard (`src/lib/externalRelay/routeGuard.ts:8`) and never trigger pairing
or service refresh. Add English and Ukrainian labels in `src/lib/i18n/en.ts`
and `uk.ts`, including “Recent answers” / “Останні відповіді” and
“Handed off to service” / “Передано сервісу”. Avoid a new global panel.
Implementation must render list and exchange, including empty/expired/failure and
long-text states, at desktop and phone widths in both languages through existing
capture infrastructure. This document introduces no rendered UI and claims no
UI verification.

**Contract documentation.** Update `relay.md` Part A schemas, features, §A.8
frame and completion semantics from the accepted wire contract. Update Part B's
implemented-state description and read-only record inspection; keep the separate
long-lived `chat_conversations` delta labelled deferred. Pairing, polling,
account selection, progress, hard caps and profile tripwire retain their behavior.

## Validation performed and remaining implementation gates

Prior-work queries included project-scoped relay/MCP and `chat_conversations`,
then unscoped full-integration and conversation terms. Relevant external design
transcript hits were opened with `conversation_messages` and checked against the
private documents and current source. Several searches dropped common query
words; their broad matches supplied no evidence. Scoped and unscoped memory
queries returned no relevant integration or bridge result. No earlier single-server
probe was found.

Current source was exported to scratch at the inspected revision for focused
tests. The worktree had no dependencies installed; an initial direct run failed
to resolve `zod`. The export used the existing dependency installation with
matching declared dependency versions (including Zod 4.4.3 and Next 16.3.6).
Its package manifest differs only by an unrelated additional braces patch entry
on the inspected revision. Tests ran one named file per process via
`scripts/gate-slot.sh`, with separate home/config/cache/state/temp roots.

| Named test file | Passing tests |
|---|---:|
| `src/lib/externalRelay/protocol.test.ts` | 2 |
| `src/lib/externalRelay/progress.test.ts` | 2 |
| `src/lib/agent/ephemeral.test.ts` | 11 |
| `src/lib/externalRelay/runner.test.ts` | 24 |
| `src/lib/externalRelay/poller.test.ts` | 16 |

Total: 55 passing tests, no failures in the completed isolated runs. No whole
runtime/registry suite was run. The two real CLI probes and parser assertions
above are separate from these tests. No build, deployment or live relay check is
required for this document-only stage.

The explicit-path publication privacy gate passed with the committed known-value
fingerprints. Every referenced repository file exists; whitespace checks passed,
and the worktree change is limited to this declared document.

Slice 1 still owes focused tests for negotiated and legacy parsing/prompt/schema
behavior, unknown fields, role/index injection, exact hand-off mapping and retry,
received-input retention, terminal/crash records, uncertain completion receipts,
the single 30-day boundary and owner-only record reads. Rendered list/exchange
evidence in en/uk is required when that UI is implemented. Real model hand-off
judgment and the external service's negotiated completion behavior must be
verified in the joint implementation stage; this deterministic probe establishes
their transport prerequisites.

## Deferred — not currently justified

- Persistent per-chat engine sessions, compaction, conversation locks, transcript
  migration between accounts and native scanner integration. Inspectable exchanges
  satisfy slice 1; permission-changing turns favor fresh authorized context.
- Replacing Claude hardening flags to expose MCP, or an engine-specific Codex MCP
  branch. The common structured loop passed without changing either profile guard.
- Direct action execution and effect reconciliation. Service-owned hand-off
  supplies the accepted action path; direct reads arrive in slice 2.
- Local files, shell, SSH, generic Viewer MCP, native web search, subagents,
  media bytes, a new permission platform or extra key types. The requirement
  requests service context and service-authorized tools.
- A new probe driver, a new global UI panel and a separate conversation browser.
  Reuse the existing runner, relay card and read-only record storage seam.
- An ADR. This reversible transport choice adds no hard-to-reverse authority or
  storage dependency; a later direct-action decision may justify one.

The originating requirement is covered by the per-engine probe and measured
fallback, the item 4 source ledger, and the accepted wire contract above.
The next implementation slice has concrete seams and acceptance checks; no
operator-only decision is needed to complete this probe stage.
