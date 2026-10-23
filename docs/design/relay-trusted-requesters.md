# Trusted relay requesters, per project

Status: proposed for #3131. Design only. Code references checked at
`adce57649`. Implement after workspace slice (b) lands; the checkout currently
contains slice (a); the workspace access rules are still under review.

## The operator's problem

The requirement, paraphrased: let the operator choose who can ask the relay to
run work for a project. Messaging the clone alone must grant no permission to
start an elevated agent. Explain access refusals clearly.

Today the target's owner switch and the service's owner flag decide whether a
message becomes a normal Delegatus agent with host access. A project allowlist
must become the local source of that permission. It is a grant of substantial
trust: workspace filtering does not make an agent's host access a sandbox.

## Choices

| Variant | Concrete behavior | Trade-off |
|---|---|---|
| A. Owner flag plus project list | Only the service-identified owner may elevate, and only when explicitly listed for the target project. | Smallest change; prevents accidental owner runs on a project but cannot delegate to another requester. |
| B. Explicit project grants, edited by the installation owner **(recommended)** | Any verified, non-anonymous requester explicitly listed for this project may elevate. The service owner is also required to be listed. | Supports delegation and has one understandable rule; requires durable requester identity, scoped downstream authority, and migration of existing setups. |
| C. Workspace managers edit project grants | Same matching as B; managers may grant elevation within their workspace. | Convenient for independent teams, but lets a workspace manager grant access to the installation's host. Workspace slice (b) alone cannot contain that authority. |

Choose B. Keep the target's enable switch as a second gate, labelled “Allow
elevated runs” in the UI. No wildcard, workspace-wide grant, role-based grant,
or implicit owner exemption. Chat administrator status is not local host trust.
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
| Policy editing | `src/lib/externalRelay/routeGuard.ts:9` guards relay settings; `src/lib/team/http.ts:59` provides the team owner check. Require an authenticated human owner for grant writes; a relay agent's operator authority must not let it edit its own grant. |
| Workspace placement | `src/lib/team/workspaces.ts:26` explicitly describes slice (a) as filtering only; `src/lib/team/workspaces.ts:57` takes an alias snapshot and `src/lib/team/workspaces.ts:99` resolves placement. Integrate the actual slice (b) project visibility API after merge, without inventing a parallel workspace permission system. |
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
reject stale UI saves instead of overwriting another edit.

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
4. Before reserving an elevated conversation or spawning, persist that tuple,
   grant ID and workspace placement with the run. Recheck current policy at
   spawn, continuation, MCP actions, delegation and answer delivery. A policy
   revision change prompts re-evaluation; an unrelated edit does not revoke a
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
review. Renaming a workspace changes nothing. Unassigned projects may have
explicit owner-managed grants, subject to slice (b)'s owner-only access rules.

A grant permits elevated relay requests for its project. The external requester
need not sign in to Delegatus and gains no team membership, workspace browsing
or policy-editing permission.
Pass the granted project through the slice (b) MCP fence and every child or
handoff; reject attempts to act for another project. Describe the granted authority in prompts as
“trusted requester for this project.” Host access remains broad and requires
trust in the requester; project routing cannot contain a hostile agent.
Do not ship B with today's unrestricted owner authority text unchanged.

## Who edits it and what they see

Only the installation's human owner edits the list, through project settings →
Relay → Trusted requesters. Solo installations retain their local operator
settings access. Team installations require the live owner session. Workspace
managers may see status for projects they can access, but cannot grant, revoke,
or inspect another workspace's requesters. Agent, service and relay identities
cannot write this policy through HTTP or MCP, even when otherwise elevated.

Show each grant's local label, relay, identity scope, added time and active or
suspended state. Enroll by selecting a requester observed in an authenticated
relay request, then explicitly confirming the project and host-access grant.
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

Depends on merged workspace (b). Confirm requester-key scope and refusal
semantics with the service contract. Add schema, lock/revision behavior, grant
IDs, owner-only editing and audit. No elevation behavior changes in this slice.

Acceptance: owner can add/remove an observed requester; member, manager, agent
and service writes fail. Stale saves conflict. Corrupt/missing policy is denied.
Tests cover alias conflict, deleted-worktree identity, re-pairing and workspace
move suspension. No identities are seeded from repository fixtures or chat text.

### 2. End-to-end authority and refusal

Gate all elevated paths with the same decision, bind durable runs, fence MCP and
handoffs to the granted project, update requester wording and integrate the
negotiated terminal refusal. Keep service-role authorization separate.

Acceptance: a listed non-owner succeeds; an unlisted service owner fails. Missing,
anonymous, spoofed, mismatched-message and wrong-pairing identities fail before
spawn. Null project, cross-project tools/handoffs, prototype, replay, restart and
old conversation reuse cannot bypass the grant. Remove a grant during queued
spawn, continuation, tool use and delivery: each refuses further authority,
requests stop and emits only safe status. Unrelated edits preserve valid runs.
Integration tests prove no fallback agent runs after an authorization refusal.

### 3. Operator UI and rollout

Add project policy controls and refusal history, translated in English and
Ukrainian. On upgrade show existing enabled targets as “Review required” and
block elevated admission until explicit enrollment; never silently seed an owner
grant. Review each configured project, requester and affected target together.

Acceptance: existing restricted targets continue normally; every previously
elevated target requires review. Desktop and phone, light and dark, show active,
suspended, empty, stale-save and stopping states using existing browser drivers.
Focused tests run with isolated state roots. A service lacking the required
identity/refusal contract cannot enable the feature. Disabling the feature must
not restore legacy owner-flag-only elevation. This design change itself requires
no runtime test or product-code change.

## Questions for the operator

1. **May a trusted non-owner start elevated runs?** Recommended: yes, variant B;
   require an explicit project grant for everyone, including the service owner.
2. **Who may edit grants?** Recommended: only the human installation owner.
   Workspace managers do not yet have an isolated host on which to delegate trust.
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
