# Trusted relay requesters, per project

Status: proposed for #3131. Design only. Code references checked at
`adce57649`. The checkout contains workspace slice (a). The accepted workspace
plan requires (b) for membership/visibility and (c) for the MCP fence. Non-owner
elevation remains blocked until those slices and a separate project execution
boundary exist; workspace level 2 leaves shell access shared.

## The operator's problem

The originating requirement (#3131, 2026-10-20), paraphrased: let the owner
allow verified relay requesters to start elevated runs restricted to one
project's working directory, board calls, hosts and credentials. The operator's
whole home and unrelated projects must remain inaccessible. Provide owner-only
MCP and board management, audit changes, and show who triggered each run.
Messaging the clone alone grants no permission. Explain access refusals clearly.

Today the target's owner switch and the service's owner flag decide whether a
message becomes a normal Delegatus agent with host access. A project allowlist
must become the local source of that permission within a project execution
boundary. Workspace filtering and the MCP fence alone cannot provide the shell,
host and credential isolation this requirement needs.

## Choices

| Variant | Concrete behavior | Trade-off |
|---|---|---|
| A. Defer delegation | Keep the existing owner-only path while the execution boundary is unavailable; ship policy preparation only. | Safe interim state; non-owner elevation stays blocked and #3131 remains incomplete. |
| B. Isolated project executor, owner-managed grants **(recommended after prerequisites)** | A verified requester with an explicit project grant runs in an executor exposing only that project's files, hosts and credentials. The service owner also needs a grant. | Preserves one management surface; requires a separately designed and verified execution boundary as well as workspace (b) and (c). |
| C. Separate isolated installation per project | Apply the same owner-managed grants in a dedicated installation under a separate OS identity or equivalent container boundary, with project-only mounts, credentials and host access. | Can satisfy the boundary with deployment separation; multiplies installations and logins. Sharing the operator's OS user, mounting its home or using a host-privileged container defeats it. |

Choose B as the eventual policy, with A as the release state until the execution
boundary is available and verified. C is an alternative only when its deployment
proves the same project-level isolation; a workspace containing several projects
cannot expose all of them to a single-project grant. Keep the target's enable
switch as a second gate, labelled “Allow elevated runs” in the UI. No wildcard,
workspace-wide grant, role-based grant or implicit owner exemption. Chat
administrator status is not local host trust.
The service still decides which chat tools a requester may use; a local grant
must not manufacture `is_owner` or unlock service owner tools.

## Current code and state affected

The table identifies current code and the proposed changes for project grants.

| Boundary | Evidence and required change |
|---|---|
| Elevation selection | `src/lib/externalRelay/profile.ts:14` checks `ownerTier`, strict owner/non-anonymous flags and triggering-message authorship. Split verified-message selection from the proposed local grant decision. |
| Wire identity | `src/lib/externalRelay/protocol.ts:117` carries an opaque requester key and role booleans. It does not establish that the key is stable across chats, targets or re-pairing. Verify that contract before allowing grants. |
| Target project and switch | `src/lib/externalRelay/store.ts:18` and `src/lib/externalRelay/store.ts:24`; target writes are validated in `src/app/api/external-relay/relays/[id]/route.ts:83` and `src/app/api/external-relay/relays/[id]/route.ts:97`. Project selection is configuration, never a project named in message text. |
| Admission and special path | `src/lib/externalRelay/runner.ts:550` selects the owner message, prototype path and profile before conversation selection at `src/lib/externalRelay/runner.ts:568` and account selection at `src/lib/externalRelay/runner.ts:579`. Apply the grant before all elevated paths, including prototype and replay. |
| Durable authority | `src/lib/externalRelay/store.ts:102` stores owner-turn metadata. `src/lib/externalRelay/ownerAuthority.ts:22`, `src/lib/externalRelay/ownerAuthority.ts:64` and `src/lib/externalRelay/ownerAuthority.ts:89` recheck settings for live authority, replies and async tools. Recovery and queued operations use `src/lib/externalRelay/ownerAuthority.ts:106` and `src/lib/externalRelay/ownerAuthority.ts:119`. Persist the grant binding and recheck it at each boundary. |
| Downstream delegation | `src/lib/externalRelay/ownerAuthority.ts:45` asserts installation-owner authority; `src/lib/externalRelay/ownerAuthority.ts:52` only constrains project routing for a bridge report. Replace that assertion for trusted non-owner requesters and enforce the granted project for every elevated relay handoff. |
| Conversation reuse | `src/lib/externalRelay/conversations.ts:14` records requester and authority; matching at `src/lib/externalRelay/conversations.ts:272` scopes a chain. Add project and grant generation to elevated reuse, so old sessions cannot restore revoked authority. |
| Launch environment and board title | `src/lib/externalRelay/ownerRun.ts:682` launches in the operator's home; `src/lib/externalRelay/ownerRun.ts:683` titles the run with only the target name. Replace the execution environment for project grants and persist requester attribution before launch. |
| Policy editing | `src/lib/externalRelay/routeGuard.ts:9` guards relay settings; `src/lib/team/http.ts:59` provides the team owner check. Both proposed management surfaces need authenticated owner authorization; the current relay route guard alone does not prove human ownership. |
| Workspace placement | `src/lib/team/workspaces.ts:26` explicitly describes slice (a) as filtering only; `src/lib/team/workspaces.ts:57` takes an alias snapshot and `src/lib/team/workspaces.ts:99` resolves placement. Integrate slice (b) visibility and slice (c) MCP fencing after merge, following `docs/design/workspaces.md:332` and the accepted Unassigned decision at `docs/design/workspaces.md:448`. |
| Persistence and audit | `src/lib/externalRelay/store.ts:131` provides private atomic file writes; `src/lib/team/events.ts:49` supports project-scoped events. Add policy transactions and durable local audit; team activity may project those events but must not be the only audit on solo installs. |
| Refusal protocol | `src/lib/externalRelay/protocol.ts:422` enumerates decline reasons; there is no authorization-specific reason. Negotiate a dedicated reason and service-visible refusal copy before rollout. |

## Proposed policy and matching

Store a versioned installation-local policy beside relay state, outside the
repository: `relay-trusted-requesters.json`. A policy has a revision and project
records. Each grant contains the canonical project key, local relay pairing ID,
credential/pairing generation, opaque requester key, unique grant ID, creation
time and human editor ID. Display labels are optional local presentation data,
never matching keys. A removal advances the revision; re-adding creates a new
grant ID. Keep audit records for add, remove, migration and refused edits.
Use a locked read-modify-write and atomic replacement, with revision checks to
reject stale UI saves instead of overwriting another edit. Keep policy changes,
audit entries and idempotency receipts in the same versioned snapshot so they
commit together; an audit-write failure must leave the grant unchanged.

Matching is exact and local:

1. Strictly parse the authenticated service request. Require a nonempty requester
   key, `is_anonymous_admin === false`, and a `respond_to` message authored by
   that key with `author.self === false`. History, forwarded text, display names,
   handles, supplied role claims inside text and chat titles grant nothing.
2. Resolve the configured target project through the existing canonical project
   resolver. A null, unknown or ambiguous project cannot elevate. Check the
   current workspace placement and slice (b) availability rules. Do not infer a
   project from the chat, previous conversation, current browser selection or
   request text. Bridge-report context must agree with the configured project.
3. Require an enabled, unpaused target with elevated runs enabled, and an exact
   grant for `(canonical project, pairing generation, requester key)`. No entry,
   unreadable policy, invalid schema or uncertain identity means refusal.
4. Require workspace slice (c)'s MCP fence and a ready project executor that
   enforces the execution boundary below. Neither a configured working directory
   nor workspace membership suffices. An unavailable boundary refuses elevation.
5. Before reserving an elevated conversation or spawning, persist that tuple,
   grant ID, workspace placement, executor binding and attribution with the run.
   Recheck current policy and execution binding at spawn, continuation, MCP
   actions, delegation and answer delivery. A policy revision change prompts
   re-evaluation; an unrelated edit does not revoke a
   still-present grant. A removed-and-re-added grant does not revive an old run.

The service must document the key's identity scope and stability. If keys are
chat-scoped, include the authenticated chat scope in both grant and run; do not
pretend that a grant follows a person to another chat. If stability cannot be
established, block elevated enrollment. Re-pairing invalidates grants even if
labels and keys look the same. Credential rotation within a proven unchanged
pairing may retain them; a changed identity cannot.

Use canonical keys for reads and writes so deleted worktrees and repository
renames follow established project identity. If aliases join conflicting policy
records, refuse elevation until the owner reconciles them; never union grants
silently. Moving a project to another workspace suspends its grants for owner
review. Renaming a workspace changes nothing. Under the accepted workspace
plan, Unassigned is visible to the owner and workspace managers from slice (b).
Only the owner may prepare grants there; keep them suspended until the project
has a workspace placement and a verified executor. Visibility grants no relay
policy-management permission.

A grant permits elevated relay requests for its project. The external requester
need not sign in to Delegatus and gains no team membership, workspace browsing
or policy-editing permission.
Pass the granted project through slice (c)'s workspace MCP fence and every
child or handoff. Add the narrower project check to every tool and delegation
path; a workspace fence still allows several projects. Describe the authority
in prompts as “trusted requester for this project.” Replace today's unrestricted
owner-authority text before enabling project grants.

## Execution prerequisite and release block

The accepted level-2 workspace choice explicitly leaves shell reads unrestricted
(`docs/design/workspaces.md:249`). Its slice (c) MCP fence is a separate required
gate. Both B and C need an execution boundary that enforces all of the following:

- The working directory and exposed checkout belong to the granted project.
  Files, transcripts and credentials of other projects, and the operator's home,
  remain inaccessible to shell commands, including absolute-path, parent-path
  and symlink reads. Environment variables, inherited descriptors and agent
  configuration cannot carry unrelated secrets into the executor.
- Remote hosts and credentials are project-specific. An SSH agent, general forge
  credential, cloud identity or unrestricted proxy into the operator's machine
  cannot turn a project grant into access to other projects. Network and remote
  authorization must enforce the allowed host/resource set.
- Children, continuations, recovery, tools and handoffs retain the same project
  boundary. A full-access local seat or helper cannot execute on the requester's
  behalf outside it. Boundary identity is persisted and rechecked after restart;
  absence or mismatch refuses admission and further authority.

The executor implementation/deployment is deferred to a separate design and
verification effort. This document authorizes no new shared-user full-access
launch path. Until that prerequisite is delivered, keep non-owner elevation
disabled even when policy, workspace (b), and workspace (c) have shipped. Test
attempted access to a second project's checkout, a second project's credentials
and an unrelated host through every execution path before release.

## Who edits it and what they see

Only the installation's human owner manages the list, through project settings →
Relay → Trusted requesters and a proposed `relay_trusted_requesters` MCP tool.
Both call the same server-side owner authorization, policy transaction and audit
writer. Team UI access requires a live owner session. Solo UI access requires
the authenticated local operator settings session. Workspace managers may see
availability status for accessible projects, including Unassigned, but cannot
inspect or edit the requester list.

The MCP tool has `list`, `add` and `remove` actions. `list` returns the project's
policy revision and grants. `add` names the canonical project and an observed,
service-verified enrollment candidate; `remove` names its existing grant ID.
Mutations carry an expected policy revision and an idempotency key. The server
resolves candidates and projects itself and rejects stale revisions.

MCP management requires a separately authenticated owner-management principal,
never authority inherited from an agent launch or relay request. An owner client
may list or prepare an exact add/remove operation. For writes, the server shows
the owner a confirmation in the authenticated settings session, bound to the
operation, project, requester, policy revision and requesting client. The client
then applies it through MCP using the recorded approval. Approval is single-use;
changed operations, a stale revision, a lost owner session, decline or no answer
require a fresh confirmation and cause no policy write. UI confirmations bind
the same values. The audit records editor, approving owner, action, grant,
project, time and before/after revision; replay returns the original receipt.

Relay, service and ordinary agent principals are refused before list, proposal
or apply, even if otherwise elevated or carrying `is_owner`. They cannot grant
themselves management credentials, answer the owner's confirmation, or replay
another client's approval. Owner management credentials stay outside project
executors. Adding a relay requester grants no policy-management authority.

Show each grant's local label, relay, identity scope, added time and active or
suspended state. Enroll by selecting a requester observed in an authenticated
relay request, then explicitly confirming the project and its isolated execution
scope. The same candidate and confirmation appear in MCP management.
An observation is only an enrollment candidate, never automatic approval.
Do not accept arbitrary display-name entry as identity proof. The relay settings
link to the same project policy; multiple targets for one project share it.

Removal takes effect immediately for new authority checks. Cancel queued work
and request interruption of running turns; report “Access removed; stopping
current work” until stop confirmation. Do not promise to undo completed actions
or stop an OS operation already in flight. Suppress generated output after
revocation; a fixed status notice may explain the stop without carrying agent
content. Previously delegated work already admitted needs explicit cancellation
tracking; revocation is not complete merely because the relay conversation stops.

## Durable requester attribution

Before admission, the relay run stores an immutable attribution snapshot:
canonical project, pairing generation, verified requester binding, grant ID,
local display label at admission, a stable local discriminator and request/run
binding. Persist it with the authority record before launch; failure to store it
refuses launch. The verified wire key stays in private relay state. The label
and discriminator are presentation only and never authorize actions.

Carry the attribution reference through launch receipts into conversation and
board records, and into child task/pipeline records created for this request.
Those readers resolve the stored snapshot after restart and archival; they do
not depend on the current grant list. Conversation reuse must match the grant
and requester so two requesters cannot share a misleading origin label. Every
continuation retains its own request attribution. Revocation retains the
historical snapshot, and later label edits affect future runs only.

On the board, show `Relay · <target> · <local requester label>` with a stable
local discriminator whenever labels collide; the run details also show the
admission-time label and whether that grant has since been removed. Apply the
existing project visibility rules. Raw requester keys, service user IDs, pairing
IDs and internal grant/run identifiers never become display labels or public
report content. Public exports use generic requester aliases while preserving
the distinction between requesters. Existing runs without a snapshot show
“Requester not recorded”; never infer one from the current target or grant list.

## Refusal experience

An elevation-enabled target returns an explicit authorization refusal when a
grant check fails. Silent downgrades and service handoffs would obscure whether
host work actually started. Targets with elevation off retain their
ordinary restricted-answer behavior.

- Requester: “This request cannot run with elevated access for this project.
  Ask the installation owner to review relay access. No elevated run started.”
- Missing project: “Elevated access is unavailable until the installation owner
  selects a project for this relay target. No elevated run started.”
- Mid-run revocation: “Access was removed. This run is stopping. Work already
  completed may remain.” Use “stopped” only after confirmation.
- Operator: a project-visible event with time, request reference, local requester
  label and a precise reason such as unlisted requester, unknown identity,
  suspended placement or unavailable policy. Offer “Review access,” never an
  automatic retry or one-click approval from the request itself.

Do not expose list membership, other requesters, internal project keys, paths or
request contents in the chat refusal. Coalesce repeated refusal events in the
UI without losing bounded diagnostic counts. Keep the wire's terminal outcome
idempotent under retries. Add `requester_not_trusted` (and a fixed safe status
mapping) through service capability negotiation; on older services use a
supported terminal refusal with generic safe copy only after integration proves
it will not trigger fallback execution. Otherwise leave elevation disabled.

## Delivery slices and acceptance

### 1. Contract and durable policy

Depends on workspace (b)'s human visibility contract. Confirm requester-key scope
and refusal semantics with the service contract. Add schema, lock/revision
behavior, grant IDs, both owner-only management surfaces and audit. Policy may be
prepared while execution prerequisites are pending; grants remain inactive.
No elevation behavior changes in this slice.

Acceptance: an authenticated owner can list/add/remove through both board UI and
MCP, observing the same policy revision and mutation receipts. Each add/remove
has a durable audit record. Missing owner authentication, member, manager, agent
and service access, relay self-grants, forged confirmations and replay by another
client fail on both
surfaces. Decline and silence write nothing. Stale saves conflict; successful
idempotent retries write once. Corrupt/missing policy is denied.
Tests cover alias conflict, deleted-worktree identity, re-pairing and workspace
move suspension. No identities are seeded from repository fixtures or chat text.

### 2. End-to-end authority and refusal

Release depends independently on merged workspace (b), slice (c)'s MCP fence,
and the separately verified execution boundary. Without any one of them, keep
non-owner elevation blocked. Gate all elevated paths with the same decision,
bind durable runs and attribution, fence MCP and handoffs to the granted project,
update requester wording and integrate the negotiated terminal refusal. Keep
service-role authorization separate.

Acceptance: with every prerequisite proved, a listed non-owner succeeds inside
the project boundary; an unlisted service owner fails. With either fence absent,
even a listed non-owner fails before spawn. From direct runs, prototype, replay,
continuation, recovered runs, MCP tools, children and handoffs, attempt reads of
another project's files/credentials, the operator's home, unrelated hosts and
out-of-project resources on an allowed host: each is denied without disclosure
or side effects. Exercise traversal, symlinks, inherited secrets and attempts to
use a local privileged helper. Missing, anonymous, spoofed, mismatched-message
and wrong-pairing identities fail before spawn. Null project, cross-project
tools/handoffs, prototype, replay, restart and old conversation reuse cannot
bypass the grant. Remove a grant during queued
spawn, continuation, tool use and delivery: each refuses further authority,
requests stop and emits only safe status. Unrelated edits preserve valid runs.
Integration tests prove no fallback agent runs after an authorization refusal.

### 3. Operator UI and rollout

Add project policy controls, refusal history and successful-run attribution,
translated in English and Ukrainian. Keep enrollment visibly pending while
execution prerequisites are unavailable. On upgrade show existing enabled
targets as “Review required” and block elevated admission until explicit
enrollment and all execution prerequisites pass; never silently seed an owner
grant. Review each configured project, requester and affected target together.

Acceptance: existing restricted targets continue normally; every previously
elevated target requires review. Desktop and phone, light and dark, show active,
suspended, empty, stale-save and stopping states using existing browser drivers.
Two allowed requesters on one target produce visibly distinct board runs,
including identical local labels. Restart, archive/reload, edit a grant label,
then remove it: both runs retain their original distinct attribution without
exposing wire identities. Child records retain the origin. Older unattributed
runs show the explicit unknown state. Use existing board browser-driver cases
for these rendered checks in both languages/themes and desktop/phone widths.
Focused tests run with isolated state roots. A service lacking the required
identity/refusal contract cannot enable the feature. Disabling the feature must
not restore legacy owner-flag-only elevation. This design change itself requires
no runtime test or product-code change.

## Questions for the operator

1. **When may a trusted non-owner start elevated runs?** Recommended: variant B
   only after workspace (b), MCP fence (c) and verified project execution
   isolation. Keep variant A until then; level 2 alone cannot satisfy #3131.
   Require an explicit grant for everyone, including the service owner.
2. **Who may manage grants, and where?** Recommended: only the human installation
   owner, through both board UI and the owner-authenticated MCP tool, with exact
   human confirmation for writes and a shared audit. Managers gain no grant
   authority from workspace management.
3. **Should a denial become a restricted answer?** Recommended: no for an
   elevation-enabled target; send an explicit terminal refusal. Keep ordinary
   restricted targets available as a deliberate alternative.
4. **What happens to current owner-enabled targets?** Recommended: block until
   reviewed, with a guided enrollment screen; do not infer consent from the old switch.
5. **Should trust follow workspace moves and re-pairing?** Recommended: suspend
   on workspace moves and invalidate on re-pairing; require owner review.
6. **How broad is one grant?** Recommended: one project and one proven requester
   identity scope within one pairing, across that project's targets. No wildcard
   or expiry in the first slice; removal revokes subsequent authority immediately.
