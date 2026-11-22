# Relay answers in Business, guest and private chats

## Originating requirement

On 2026-11-21 the operator answered the relay service's question about photos
in private chats (source: the operator's form answer, relayed to this
project's seat on the task card; the private details stay on the card). In
paraphrase: in every chat (Business, guest, private) the bot sees the history,
including photos. The service's own routing decides whether to answer. When it
answers and the relay is configured, the answer always goes through Delegatus.
If the relay is unavailable, the service's built-in bot answers under a
separately agreed budget.

On 2026-11-22 the two seats agreed the wire contract. The capability is named
`relay_business_answers`, and a Business claim carries
`request.delivery = "business"`. On Business and guest surfaces the service
ignores a completion's unrelated `reply_to` and delivers to the anchor it
froze. This install advertises the capability only after it qualifies against
the service's fixtures.

Pinned acceptance, in short:

1. Parse Business claims and non-owner guest and private claims. Check the
   capability on the claim itself, and leak no raw platform ids.
2. Keep media on authorized history items, not only on the trigger.
3. Run these turns isolated: no owner sessions, no owner memory, no owner
   tools. Validate requester and author before any tool is exposed. Refuse a
   forged requester flag or a swapped author.
4. First version: one final text reply on the new surfaces, delivered to the
   frozen anchor.
5. Advertise only after the parser, runner, action validation, media
   download, privacy and settled delivery have been exercised. Incompatible
   peers keep their current shapes.

The capability stays off until the seat confirms qualification against the
service's final fixture revision.

## What the service sends (read from its fixtures, read-only)

The six paired fixtures pair a poll body and a claimed request with this
install's completion and the server's expected outcome. All six expect
`accepted`. None of them is a refusal case. The hostile cases (forged flags,
swapped author, out-of-scope media, lost ACK, delivery unknown) appear only in
the service's design list. We derive our own synthetic versions of them below.

| Partner fixture (basename) | Poll features | Claim shape | Point it pins |
|---|---|---|---|
| `answer_pair_business_contact.json` | `requester_context`, `relay_business_answers`, `relay_media_in`, `relay_history_media` | `delivery:"business"`, request `features` echoed, non-owner requester, a ready photo on an **earlier** item, progress `none`, no tools | History photo kept. Unrelated `reply_to` is ignored and the frozen anchor is used. |
| `answer_pair_business_owner.json` | `requester_context`, `relay_business_answers` | `delivery:"business"`, `is_owner:true`, trigger authored by the requester, the contact's earlier text | A real owner follow-up is accepted on the Business surface. |
| `answer_pair_guest_non_owner.json` | `requester_context`, `relay_guest_answers`, `relay_isolated_requesters` | `delivery:"guest"`, `is_owner:false`, **no request `features`** | A non-owner guest is accepted only after `relay_isolated_requesters` is negotiated. |
| `answer_pair_private_non_owner.json` | `requester_context`, `relay_isolated_requesters` | **ordinary shape** (no `delivery`, no request `features`), progress `notes`, `is_owner:false` | A non-owner private chat has no wire discriminator; see Contract gap. |
| `answer_pair_group_non_owner.json` | `requester_context` | ordinary group claim, member requester, member tool index | Existing behaviour. `reply_to` equal to the anchor. |
| `answer_pair_legacy_no_business.json` | none | ordinary claim, no requester | An incompatible peer keeps the current shape and receives no Business claim. |

Two facts from the service's code shape this design:

- Business history photos need only `relay_media_in`. The service admits
  history photos for guest or Business delivery, or when
  `relay_history_media` is negotiated. Its descriptor never lists
  `relay_history_media`, and `relayClaimCapabilities` (`poller.ts:451`)
  advertises it only when the descriptor lists it. In production, then, a
  Business claim from this install carries no `relay_history_media`, and the
  parser must still keep its history photos.
- The descriptor lists `relay_business_answers`. It lists neither
  `relay_guest_answers` nor `relay_isolated_requesters`. The server ignores
  unknown features. Like `relay_guest_answers` today, the two new features
  are gated on our own switch, without a descriptor check.

### Contract gap: no private discriminator on the wire

The service's slice-3 text asks for "an explicit private discriminator where
the peer would otherwise apply group semantics". Its fixture and its
`requires_isolated_requester` predicate send a non-owner private chat as an
ordinary claim with no marker. On our side that claim runs exactly as a
non-owner group member's turn runs today: no owner tier, no owner tools (the
owner audience needs `is_owner`), admin tools only for `is_admin`, and a
member-authority chain conversation keyed by that chat. None of that reaches
the owner's sessions, memory or tools, so acceptance item 3 holds without a
discriminator. What group semantics still allows is the model's `ignore`
action and progress notes, both of which the service sent in its own fixture.
The seat should confirm with the service seat that this shape is final. A
future `delivery` value for private chats would be a separate, additive
reader change. This lane does not anticipate it.

## Design

### 1. One predicate for isolated surfaces

`src/lib/externalRelay/mediaInputValidation.ts` gets
`isolatedDelivery(request) = delivery === "guest" || delivery === "business"`.
It lives there because `protocol.ts` already imports that module, so defining
it in `protocol.ts` would create an import cycle. `protocol.ts` re-exports it,
and `MediaRequest.delivery` widens to `"guest" | "business"`.

Every `delivery === "guest"` / `!== "guest"` branch listed below switches to
the predicate. The current guest isolation (fresh request-local run, no chain
conversation, no tool index, no page reader, no progress, no rich output,
`reply_to: null`, scrubbed text, masked diagnostics) therefore applies to
Business without a second set of branches:

| File | Function / site | Effect for Business |
|---|---|---|
| `protocol.ts` | `requestSchema` preprocess (history keep, document strip) and superRefine; `relayToolAudience` (owner audience); `offersHandoff`; `checkedAnswer` (`ignore` refused, `reply_to` forced to `null`) | Same contract as guest. |
| `profile.ts` | `ownerTierFor` | Never owner tier, even for `is_owner:true` (Business owner follow-up). |
| `toolLoop.ts` | `callableReads`, `callableTools`, `roundTools` | No direct tools and no `read_page`. |
| `toolIndex.ts` | `hydrateToolIndex` | No lookup call. |
| `answerV2.ts` | `answerCapabilities` | No rich output and no attachments. |
| `prompt.ts` | answer actions, the `reply_to is null` line, `read_page` lines | Same prompt as guest. |
| `ownerRun.ts` | guest rule, `[ignore]`, `reply_to` | Defensive only; owner runs never start for isolated delivery. |
| `runner.ts` | `logDiagnostic`; guest answer recheck after the run; `steps`; `delete profile.pageRead`; `usesConversation`; `seenMessageIds`; `privateContext` for the local and Cloud runs; `scrubOwnerReply`; `guestAnswerSchema` selection | Request-local `privateContext` run with no session persistence, credential scrub and no progress. |

`privateContext` is the mechanism that keeps owner memory out. In
`agent/ephemeral.ts` it gives Claude a request-local `CLAUDE_CONFIG_DIR` with
auto memory and hooks off, telemetry off and `--no-session-persistence`. It
gives Codex a request-local `CODEX_HOME`. Owner sessions stay out because
`usesConversation` is false and no `ownerRun` path starts. Owner tools stay
out because `ownerTierFor` returns null (no Viewer MCP and no owner service
tools) and `relayToolAudience` refuses the owner audience.

### 2. Parser: capability checked on the claim itself

`protocol.ts` turns the schema into a factory,
`claimedRequestSchema(advertised: readonly string[])`. It keeps
`export const requestSchema = claimedRequestSchema([])`, so every current
caller (owner recovery in `poller.ts:237,258`, the existing tests) parses
exactly as today. A Business claim and a non-owner guest claim are refused
unless the poll that leased them advertised the matching feature.

- `delivery: z.enum(["guest", "business"]).optional()`.
- Requester rules, applied before any tool list or session (the existing
  `INVALID_REQUESTER_DETAIL` refusal):
  - An isolated delivery needs a requester, and `requesterTrigger` must hold:
    exactly one non-`self` trigger whose author is the requester. This
    refuses a swapped author, a swapped key, a duplicate trigger and a self
    trigger.
  - An isolated delivery needs `is_admin`, `can_restrict_members`,
    `can_delete_messages` and `is_anonymous_admin` all false. The service
    always sends false on these surfaces, so a true value is a forged flag.
  - Guest with `is_owner:false` is refused unless `advertised` contains
    `relay_isolated_requesters`. This keeps today's refusal when the feature
    is off.
  - Business accepts either value of `is_owner`. The flag grants nothing on
    this surface. Its only effect is the existing member-limit exemption
    (`exemptFromMemberLimit`), which follows the service's authenticated
    claim.
- Business contract (refused as `invalid_request`):
  - `advertised` must contain `relay_business_answers`, and the claim's own
    `features` must contain both `requester_context` and
    `relay_business_answers`.
  - The guest rules also apply: progress `none`, no `owner_delivery` (so no
    raw chat id reaches a Business turn), no `input.format`, no
    `answer.attachments`, handoff-only tools, and media only with
    `relay_media_in`.
- History media: `hasHistoryMedia` and the preprocess `history` flag use
  `isolatedDelivery(...) || features includes relay_history_media`, which
  mirrors the service. `validateMediaInput` keeps its strict rules:
  - only photos on non-anchor items;
  - a document only on the anchor or its reply target;
  - conflicting duplicate descriptors refused;
  - at most 10 refs and the byte budgets.

`runner.ts:207` parses with
`claimedRequestSchema(runtime?.advertisedFeatures ?? [])`. `poller.ts:543`
builds `const claimBody = relayClaimBody(relay)` once per poll, sends it, and
passes `advertisedFeatures: claimBody.features` into `runClaimedRequest`
(`poller.ts:562`). A lease is judged by the features its own poll advertised.
Withdrawing the switch therefore stops new admissions while a claimed lease
settles under its original contract, as the service's README requires.

### 3. Media-capable runner for history photos on a Cloud target

Today `runner.ts:906-911` hands a turn back to the service when a Codex Cloud
target gets ready history photos. Cloud turns are text only. The service seat
reported this as a defect. Under the requirement, an answer must go through
Delegatus whenever the relay is configured.

The change: at `runner.ts:753`, a non-owner-tier turn on a Cloud target whose
`validateMediaInput` holds a ready inbound image sets `usingCloud = false`
when the switch is on. The turn then runs on the existing local fallback path
(`target.engine` codex, `target.model`, request-local `privateContext` for
isolated delivery, `inputImages` from `prepareInboundMedia`).

The existing `selectAccount` / `capacityDecline` admission bounds it, so an
install without a local Codex account declines `no_capacity`, and the
service's fallback budget applies. With the switch off, the two handoff
branches stay as they are. That keeps
`Codex Cloud hands guest history photos back…` in `guestMode.test.ts`
unchanged.

### 4. Delivery to the frozen anchor

For isolated delivery the completion's `answer.reply_to` is always `null`.
This follows from the predicate in `checkedAnswer` and the runner's recheck at
`runner.ts:380`, and `guestAnswerSchema` already pins `reply_to` to `null`.
The anchor stays server-side. We never invent one and never forward the
model's choice.

One final plain-text reply goes through the unchanged `completeRelayRequest`:

- 2xx is `accepted`.
- A transport loss retries the same body until the request deadline and then
  records `unconfirmed`.
- `409 lease_lost`, 401, 404 and 413 are recorded as `refused`.

There is no late delivery, because `owner_delivery` is refused on these
surfaces. The answer record keeps the same operator-only shape as today, and
`logDiagnostic` keeps only `source` for every isolated delivery.

### 5. Advertisement switch

`switches.ts` gains `"relay:business_answers:enabled"` (default false), read
as `readRelaySwitches().business_answers`. Like `relay:owner_tools:enabled`,
the seat sets it in `state/external-relay/switches.json` after qualification.
No UI is added.

When the switch is on, `relayClaimCapabilities` (`poller.ts:451`) appends
`relay_isolated_requesters` and `relay_business_answers`. The same switch
gates the Cloud media rule of §3. When it is off, the claim body, the parser
(through `advertised`) and the runner behave byte for byte as on `main`. The
legacy pair and every existing claim-body expectation therefore stay
unchanged.

### 6. Synthetic fixtures mapped to the partner set

New module: `src/lib/externalRelay/businessAnswers.fixture.ts`. It exports
builders. It copies no service JSON and no service instruction text. Every
identifier is a deterministic neutral placeholder (`c_business_fixture_01`,
`u_contact_fixture`, `u_owner_fixture`, `m_history_photo`, `m_anchor`,
`media_` followed by a fixed 32-hex value, a short neutral `instructions`
line). The ids follow the wire regexes. Each added line goes through the
privacy gate's `sensitiveClasses` before the commit.

| Synthetic pair | Mirrors | Expected |
|---|---|---|
| `businessContactHistoryPhoto()` (with and without `relay_history_media`) | `answer_pair_business_contact.json` | accepted; photo downloaded through the lease-bound route and given to the model; completion `reply_to:null` although the model named another id |
| `businessOwnerFollowUp()` | `answer_pair_business_owner.json` | accepted; no owner tier even with `target.ownerTier:true` |
| `guestNonOwner()` | `answer_pair_guest_non_owner.json` | accepted with `relay_isolated_requesters` advertised; `invalid_request` without it |
| `privateNonOwner()` | `answer_pair_private_non_owner.json` | accepted as a member turn; no owner tier, no owner tools |
| `groupNonOwner()` | `answer_pair_group_non_owner.json` | accepted; owner-audience tools hidden; `reply_to` kept |
| `legacyNoBusiness()` | `answer_pair_legacy_no_business.json` | accepted; claim body without either new feature while the switch is off |

The hostile variants come from the service's design list and are not in its
six files. Each is built from the pairs above and expects
`declined invalid_request` before account selection, tool index, session or
run ledger. That matches the assertions of the existing matrix at
`guestMode.test.ts:73-111`:

- forged `is_admin`, `can_*` or `is_anonymous_admin` on Business or guest;
- `is_owner:true` on a member-authored Business trigger with
  `target.ownerTier:true` (accepted, and it must stay non-owner);
- swapped trigger author, swapped requester key, duplicate trigger, self
  trigger;
- Business without `relay_business_answers` in the claim's `features`, or not
  advertised by the poll;
- `owner_delivery`, progress `notes`, direct tools, `format` or `attachments`
  on Business;
- out-of-scope media: a document on a history item, a conflicting duplicate
  ref, 11 refs, or media without `relay_media_in`.

The delivery cases run against `startTestRelay`:

- lost ACK: the first completion attempt gets a 503 and the retry is accepted;
- delivery unknown: completion never answers before the deadline and the
  outcome is `unconfirmed`;
- late completion: `409 lease_lost` is `refused`, with no retry.

### 7. Tests (new file `src/lib/externalRelay/businessAnswers.test.ts`)

1. **Parser matrix.** Every synthetic pair and hostile variant goes through
   `claimedRequestSchema(pair.claimBody.features)` and through the default
   `requestSchema`, with the expected success or refusal.
2. **Runner per pair.** `startTestRelay` serves the claim, and
   `runClaimedRequest(..., { leaseWorker:false, advertisedFeatures })` runs
   with a fake headless runtime that answers
   `{action:"reply", text, reply_to:"m_unrelated"}`. The test asserts the
   POSTed completion body, `delivery` in the answer record, and the media
   endpoint hits.
3. **Isolation.** These run for Business contact, Business owner (with
   `ownerTier:true`) and guest non-owner, on Claude and Codex:
   - `ownerPorts` and `resolveOwnerOutboundContext` / `resolveOwnerBridgeContext`
     are spied and never called;
   - `readConversations()` is empty and no lookup endpoint is called;
   - the spawned run's `CLAUDE_CONFIG_DIR` or `CODEX_HOME` is under the
     request run directory and not the account home, and
     `--no-session-persistence` is set;
   - a canary written into the account home's instruction and memory files
     appears in no prompt or input file;
   - owner-audience tools offered in the claim appear in no prompt.

   A second request in the same chat sees none of the first one's text
   outside the service's own conversation.
4. **Cloud media.** A Cloud target with the switch on runs locally with the
   image. With the switch off it keeps the existing handoff.
5. **Advertisement.** `relayClaimBody` is checked with the switch off and on.
   A switch turned off after the claim still settles that lease.

Existing files to run by path, with isolated HOME, XDG_CONFIG_HOME, TMPDIR and
`LLV_STATE_DIR` and the control URL on a closed port:

- `protocol.test.ts`, `guestMode.test.ts`, `historyMedia.test.ts`
- `ownerTier.test.ts`, `ownerRelayContract.test.ts`, `poller.test.ts`
- `toolLoop.test.ts`, `prompt.test.ts`, `answerV2.test.ts`
- `mediaInput.test.ts`, `slice3Runner.test.ts`, `runner.test.ts`

The guest contract test at `guestMode.test.ts:60` keeps passing because the
default `requestSchema` still refuses a non-owner guest.

## Validation against the requirement

- **History photos.** A Business contact's earlier photo reaches the model.
  This holds without `relay_history_media`, and on a Cloud target once the
  switch is on (§2, §3).
- **The service decides whether to answer.** Our side never adds an
  `ignore` on isolated surfaces. Handoff stays available because the
  service's contract keeps it.
- **The answer always goes through Delegatus.** The Cloud media handoff is
  removed under the switch. Remaining declines (`no_capacity`, member limit,
  `invalid_request`) are the relay-unavailable cases that the agreed fallback
  budget covers.
- **Isolation (§1).** Proven by the tests in §7.3.
- **Capability off by default (§5).**

## Deferred — not currently justified

- A private `delivery` discriminator reader: the service sends none (see
  Contract gap).
- Rich output, attachments, progress or tools on Business and guest: the
  first version is one final text reply.
- Chain conversations for Business contacts: each turn stays request-local.
  The service supplies the history window.
- A settings UI for the switch: `relay:owner_tools:enabled` has none either.
- The Cloud media rule for owner-tier turns: owner turns already have a full
  local path.
