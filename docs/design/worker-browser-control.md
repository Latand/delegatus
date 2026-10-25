# Let a worker drive the operator's browser when asked

Design proposal for issue #2240. Source: Codex Cloud (GPT-6.1 Sol), result `25.diff`, collected 2026-10-23. Implementation is separate work.
Code references checked against `adce57649`.

## The operator's problem

In the operator's words, paraphrased: “I asked this worker to use my browser to
finish the task. It still cannot touch it. Let me give that worker control of
the tabs I choose, show me when it has control, and let me take control back.”

Permission is limited to a particular worker, browser surface and task. Reading a
signed-in page is itself access to private data. A click may send a message,
publish a change or spend money; browser control alone must not authorize those
outcomes.

**Recommendation:** a short-lived, operator-approved grant to one worker,
mediated on every call through the existing `viewer` MCP and a trusted browser
adapter. Default to one selected tab, its current origin, and 15 minutes. Keep
worker MCP and plugin defaults unchanged. Launch only after the adapter proves
that it can enforce the grant and stop dispatch on revocation.

## Current boundaries and affected state

The following boundaries exist in the current code. Browser delegation is proposed below.

| Current boundary | Evidence and implication |
| --- | --- |
| Workers start with only `viewer`; the grantable MCP set is `viewer` and `telegram`. | `src/lib/agent/mcpAllowlist.ts:29`, `src/lib/agent/mcpAllowlist.ts:43`, `src/lib/agent/mcpAllowlist.ts:52`. Adding an arbitrary browser server to a spawn request cannot grant it. |
| Stored grants are re-evaluated against affirmative origin evidence. | `src/lib/agent/mcpAllowlist.ts:234`, `src/lib/agent/mcpAllowlist.ts:252`. A modified launch profile must not become browser authorization. |
| Computer-use is a root plugin default; delegated plugin defaults are empty. | `src/lib/agent/pluginAllowlist.ts:21`, `src/lib/agent/pluginAllowlist.ts:26`, `src/lib/agent/pluginAllowlist.ts:32`. Desktop control and scoped browser control are different capabilities. |
| Engine configuration materializes the MCP allowlist and disables unselected configured servers. | `src/lib/agent/cli.ts:356`. Codex also verifies plugin-contributed servers against the grant at `src/lib/runtime/codexAppServerHost.ts:1752`. Preserve those checks. |
| MCP calls carry transport-derived caller context. | `src/lib/mcp/callerContext.ts:20`, `src/lib/mcp/callerContext.ts:38`. Bind browser calls to resolved caller identity, never a worker-supplied conversation identifier. |
| Browser-only approval has an existing pattern. | `src/lib/voiceCompanion/http.ts:26` rejects agent capability requests and requires an operator browser request. `src/lib/voiceTools/http.ts:68` rechecks authority after reading the body; `src/lib/voiceTools/http.ts:80` gives MCP a separate proposal-only route. Reuse the separation and design browser-specific ownership checks. |
| Moving the Delegatus view is already separately restricted. | `src/lib/mcp/server.ts:3720` describes root/seat authority and refuses workers. A browser grant must not implicitly grant `request_attention` or change that policy. |
| Durable state has existing transaction and ownership boundaries. | `src/lib/state/sqliteStateStore.ts:583` implements asynchronous state transactions; `src/lib/state/currentDatabase.ts:66` opens the current database. `src/lib/stateOwnership.ts:49` and `src/lib/stateOwnership.ts:55` distinguish state owners and startup mutation owners. Use the existing storage layer and release fence for migration. |

The inspected paths establish launch policy and caller provenance, but do not
establish a usable operator-browser adapter. Browser tooling available to a
development agent is not evidence that Delegatus can connect to it. Discovering
and verifying a supported installed adapter is a first implementation slice.

## Three concrete variants

| Variant | Operator experience | Trade-off |
| --- | --- | --- |
| A. Grant the worker a configured browser MCP directly | Choose a worker and enable that server for its session. | Smallest launch-policy change, but server enablement alone cannot enforce tab/origin scope, immediate expiry or per-action audit. Requires those guarantees inside every backend and risks stale grants on resume. Do not ship as a generic server grant. |
| B. Broker a scoped grant through `viewer` **(recommended)** | Select a tab, scope and duration in Delegatus; the worker gets browser operations while the grant is active. | One consistent authorization and audit boundary across engines. Requires a trusted adapter and narrowly defined operations. Adds a hop but permits grants to existing workers without restart or global config changes. |
| C. Approve each browser action | Review every read, navigation, click or text entry before execution. | Explicit and useful for occasional sensitive steps, but unusable for ordinary multi-step browsing. It still needs a trusted transport and scope enforcement. Within B, reserve per-action approval for sensitive steps. |

## Grant and operator experience

A worker can propose browser access, or the operator can open “Give browser
control” on that worker. A proposal records intent only; it does not connect to
or enumerate the operator's tabs. The approval panel shows the worker and task,
selected tab, permitted origins, action classes, expiry and the private-data
implication. Only an authenticated operator with authority over that browser
connection may approve. Other team members, seats and workers cannot approve
on the operator's behalf. A natural-language request can prefill this panel;
it does not silently expand scope.

Initial scope:

- Exactly one worker conversation and active runtime generation, one browser
  connection incarnation, and one stable tab identifier. No inheritance by
  children, sibling workers, retries, scheduled work or replacement generations.
- One exact origin, selected from the tab by the operator. No wildcard origins,
  whole-profile grants or automatic inclusion of newly opened tabs. Store the
  exact value privately; do not include it in public diagnostics.
- Read and ordinary interaction are separately selectable. Read includes
  snapshots and screenshots; interaction includes scrolling, clicking, typing
  and navigation within scope. Default to read unless the operator explicitly
  selects interaction. Both remain subject to the restrictions below.
- Fifteen minutes by default, at most sixty minutes per approval, ending earlier
  when the task completes, worker stops, operator revokes, tab closes, connection
  changes or the control lease is lost. Extension requires a fresh operator
  approval and never resets automatically on activity.

Display a persistent “Worker has browser access” strip in Delegatus and a badge
or overlay on the controlled browser tab, including worker/task, mode, countdown
and **Stop control**. It must not depend on the chat being visible. Require a
working adapter-side indicator before activation. Show the active operation
without exposing typed secrets. Only one worker controls a tab at a time;
operator takeover pauses dispatch and requires explicit resumption. Closing the
panel is not revocation; Stop control is always one action away.

An out-of-scope destination pauses the operation and offers a new scope request.
It never navigates first and asks later. A popup is not a newly authorized tab.
The operator may do login, MFA or another manual step, then approve resumption
against a freshly inspected tab. Do not capture credentials during that step.

## Transport and enforcement

Proposed tools on the existing `viewer` MCP are `browser_control_request`,
`browser_control_status`, `browser_control_release`, and `browser_control_call`.
These names are design placeholders. Request/status/release expose only the
caller's own grants; request cannot approve. `browser_control_call` accepts a
grant reference, operation id and a validated narrow operation. Reject arbitrary
backend tool names and unfiltered argument objects.

Flow: authenticated worker MCP call → Viewer caller resolution → durable grant
and operation admission → trusted adapter over its supported MCP transport →
existing browser tools → filtered result and audit completion. Reuse the
installed backend's supported stdio or authenticated local connection; do not
open a remote debugging port, copy browser profiles, or pass browser credentials
to the worker. Backend registration and pairing are operator-only. Pin the
adapter identity, version/capabilities and allowed operation schemas; a change
invalidates active grants. A tool catalog change cannot expand a grant.

The broker verifies worker identity, runtime generation, grant revision, expiry,
connection incarnation, tab and action class on every call. The adapter verifies
a short-lived dispatch permit immediately before execution and restricts both
input targets and returned data to scope. Never pass the grant as a transferable
bearer credential to the worker. All alternate raw browser/desktop transports
remain unavailable to that worker.

Origin enforcement includes frames, navigation redirects, popups, screenshots
and tool results. Read snapshots omit out-of-scope frames; screenshots must mask
them or be denied. Never return global tab listings. Navigation must stop before
an out-of-scope commit; clicking a link cannot evade the same check. DOM handles
are tied to tab and document generation and expire on navigation. If the backend
cannot enforce these guarantees, disable the unsupported operation or declare
the adapter ineligible. A prompt instruction or a post-navigation URL check is
not an enforcement substitute. Origin scoping bounds page access. Ordinary page network requests can still cause remote
side effects.

Serialize actions per tab. Reserve an operation id durably before dispatch and
bind it to the canonical argument digest and caller. A duplicate returns its
recorded result; different arguments with the same id are refused. After a
transport timeout, report `outcome_unknown` and reconcile through the adapter's
operation receipt. Never automatically retry a click, submission or text entry
whose outcome is unknown.

Revocation commits a terminal grant revision, cancels queued operations and
invalidates outstanding permits. The adapter checks the current lease at the
execution boundary; loss of connectivity or heartbeat fails closed. Target a
five-second maximum lease, with the exact bound verified in adapter tests.
After acknowledgement of Stop control, no new action may start. An action that
already crossed the execution boundary may finish and cannot be undone by
revocation; display that fact and preserve its final or unknown outcome. Local
adapter Stop control blocks immediately even while the Viewer is unreachable.
Late results are audited but withheld from the worker after revocation.

## State and audit proposal

Store private durable grant and operation records in the existing state
store. Keep authorization out of writable launch-profile fields:

| Record | Fields and lifecycle |
| --- | --- |
| Grant | Opaque id; operator authority reference; worker conversation and runtime generation; task reference; adapter/connection incarnation; tab and document binding; private origin set; allowed operations; proposal digest; creation/approval/expiry times; revision; terminal reason. |
| Operation | Grant id/revision; caller; idempotency id; canonical argument digest; operation class; target reference; admitted/dispatched/completed times; adapter receipt; status and sanitized refusal/error. |
| Audit event | Ordered event id, timestamp, grant/operation reference, actor kind and private attribution reference, transition, reason, scope revision, outcome. |
| Ephemeral lease | Adapter connection, execution permits, heartbeat and current tab lock. Never restored as active authority. |

State machine: `requested → active → revoked | expired | completed | interrupted`,
with `requested → rejected` also possible. Scope changes end the old grant and
require a new approval. Operator approval and its audit event commit together;
operation admission and its audit event also commit together. Audit-write failure
blocks new execution, but must never block revocation: stop locally first and
reconcile the terminal event when storage recovers.

Persist proposals and terminal history across restart, but interrupt all active
grants on Viewer/adapter restart or runtime replacement. A surviving process
cannot reuse an old lease. No cross-release handover of browser control in v1.
Store sensitive target details separately from the sanitized event summary. Do
not retain screenshots, page bodies, form text, URL query strings, credentials
or cookies in this audit. Worker-visible page content still enters its model
context/transcript; say so at approval, and apply normal transcript access rules.

The operator can inspect approvals, scope, operations, denials, expiry,
revocation and uncertain outcomes. Proposed retention: 30 days for sanitized
audit and terminal records, with explicit deletion controls and immediate
removal of ephemeral content. Active records cannot be silently purged. Public
exports contain only synthetic labels and aggregate outcomes.

## What stays forbidden

- Self-grant, approval by another agent, delegated onward grants, wildcard
  sessions, scope expansion from page instructions, and replay of old approvals.
- Cookie, password, token, browser storage or profile extraction; credential
  entry by the worker; reading password-manager, browser settings or extension
  pages; developer tools, arbitrary JavaScript evaluation, shell and raw network
  operations through the adapter.
- Access to unselected tabs, out-of-scope frames, other browser profiles, the
  desktop, clipboard, local files, downloads or uploads in v1.
- Treating browser access as authorization to send messages, publish, buy,
  transfer funds, delete data, change permissions or security settings. Those
  actions require a separate operator decision bound to the exact action and
  payload. Where the adapter cannot reliably constrain or identify such a step,
  stop for manual operator execution; do not rely on the model to classify it.
- Changing worker sandbox, plugin/MCP defaults, `request_attention` authority or
  existing tool-specific restrictions as a side effect of a browser grant.

Page content remains untrusted task data. It cannot approve access, extend time,
choose another worker or change the broker's policy.

## Delivery slices and acceptance criteria

1. **Adapter feasibility and contract.** Inventory supported existing browser
   tools/MCP and document pairing, tab ids, frame filtering, navigation guards,
   operation receipts, indicator and stop behavior. A fake adapter exercises the
   contract. Acceptance: demonstrate scope enforcement before navigation and
   local stop during connection loss; unsupported backends are visibly refused.
   No production grants before this passes.
2. **Authority and durable state.** Implement proposal/approval/revocation routes,
   grant state and audit with the existing caller and state boundaries.
   Acceptance: agent requests, forged caller ids, cross-operator approvals,
   altered digests, expired grants and old runtime generations cannot activate
   or use a grant. Concurrent approve/revoke and restart fail closed. Audit
   failures block admission and never prevent Stop control.
3. **Read-only pilot.** Add brokered scoped reads and the two visible indicators.
   Acceptance: only the selected tab/origin is readable, including embedded
   frames and screenshots; neither global tabs nor secret fields leak. Countdown,
   expiry and one-action stop work with the conversation hidden. All lifecycle
   and refusal events appear in the private audit.
4. **Bounded interaction.** Add serialized click/type/scroll/navigation and
   operator takeover. Acceptance: redirects/popups cannot broaden scope, stale
   DOM handles fail, uncertain actions are not retried, and separate sensitive
   actions pause for exact approval or manual completion. Race tests establish
   that revoked queued operations never execute and already-started actions
   are reported honestly.
5. **Engine and failure rehearsal.** Exercise an already-running worker through
   each supported engine's existing `viewer` transport. Acceptance: no engine
   restart or global config edit is required; sibling/child workers remain
   denied; connection loss, Viewer restart, adapter replacement and worker
   completion terminate control. Validate UI using the existing conversation
   browser driver, in both shipped languages/themes and desktop/mobile layouts.
   Mobile may revoke but need not host a controlled browser in v1.

Implementation checks use explicit test files and isolated `HOME`,
`XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR`. Never run browser tests against
the operator's real profile or lifecycle tests against live state. This design
requires no runtime-host changes; if later implementation introduces them,
apply that subsystem's required review rounds and verification.

## Questions for the operator

1. **Which grant model should ship?** Recommended: B, a brokered grant through
   `viewer`, with selective per-action approval. Do not grant a raw browser MCP
   or desktop plugin to workers.
2. **What should be selected by default?** Recommended: one tab, its exact
   current origin and read-only access; interaction is an explicit choice.
3. **How long should control last?** Recommended: 15 minutes, capped at 60 per
   approval, with no automatic extension and no survival across restart.
4. **Can a spoken or typed instruction activate control immediately?**
   Recommended: it prepares the scope panel; the authenticated operator confirms
   that concrete scope once. Subsequent ordinary in-scope actions need no prompt.
5. **How should sensitive actions work in the first release?** Recommended:
   manual operator execution unless an adapter can bind a separate approval to
   the exact action and payload. Exclude files, clipboard and credential entry.
6. **What happens when the operator intervenes or a connection fails?**
   Recommended: pause immediately, fail closed on lease loss, and require explicit
   resumption; report already-started or uncertain actions without claiming undo.
7. **What should be retained?** Recommended: private sanitized audit for 30 days,
   no browser content in that audit, and clear disclosure that content returned
   to the worker remains subject to conversation retention.
