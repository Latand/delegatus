# Telegram relay publication

The Celestia owner-private-chat and publish design, section 6, is pinned by
SHA-256 `a40867d40cc41866ac6419f70217add173abb3c1a9f2ece378007ee877924c85`.

Delegatus already claims `requester_context`. An owner request with all admin
flags false reaches the existing owner tier. Handoff items remain outside the
callable tool index. The private-loop test feeds stored review text and a
copied answer through the real Telegram sender and relay runner, recording the
same decision as the web review.

The shared Telegram bot service commits each confirmed send to
`telegram/bot.sqlite` before reporting send completion. The `relay_outbound`
row contains its bot, chat, topic, Telegram message ID/date, readable text,
reply identity, origin, conversation attribution and send group. The same row
holds its pending publication obligation, frozen to the selected pairing,
target and owner without a credential. Ordinary text, partial text sends,
media captions, documents, rich reviews, native decision polls, operator test
posts and sign-in replies use this boundary. Rich fallbacks retain their actual
fallback wording. Operator and system origins remain distinct from the assistant.
The existing agent-message view keeps its previous attribution behavior.

The production queue admits at most 16 indexed pending rows per tick. It runs
asynchronously after sends and startup, with one shared bot-service owner,
five-second transport deadlines including DNS, persistent exponential backoff and persistent
429 cooldowns. A 404 holds the target for five minutes. A 400, 403 or 409 ends that
publication with its bounded status and reason recorded. Transient attempts
stop after 64 attempts or at the original Telegram date plus 24 hours.
Before replay and again after DNS, the emission guard checks
the connected bot, pairing, target, owner and posting policy. Revocation leaves
the obligation pending. The idempotent service endpoint receives the original
Telegram identity and text after a restart. Recovery never sends to Telegram.
Uncertain Telegram sends retain their original send claim without inventing a
receipt. A publication-target lookup failure before the first Telegram call
settles text, photo, album and document claims with zero sent IDs, so the
original request key can retry. Completed sends replay their receipt even
when that lookup is unavailable. Posts made without a selected production
pairing remain locally recorded.
An authenticated linked install can publish those receipts through its own
production pairing, as described below. A later local pairing cannot adopt them.

Unicode and encoded JSON publication limits retain a visible truncation marker.
The full confirmed text remains local. Confirmed service mappings also retain
the topic; legacy mappings without that field cannot prove a topic. Publication
acceptance, local Telegram delivery and relay completion acceptance remain
separate records. Relay final answers delivered by Celestia keep their existing
answer archive and completion acknowledgement; Celestia owns their Telegram
receipts. Edits and deletions remain outside this protocol.

Fresh owner prompts can recover up to 32 local receipts and 64 KiB of text in
the preceding 30 days. A confirmed publication identity in the current turn
must prove the bot, pairing, target, chat and topic. An explicit parent has
priority even when its service-history row is missing; replies to any part
recover that parent's send group within the same bounds. Otherwise the latest
question group and recent local context since the preceding owner turn appear
before the unthreaded answer, with their full options and source attribution.
Repeated request IDs reuse their persisted owner-turn cutoff.
Receipts in the cutoff's Telegram second remain eligible:
second precision cannot establish their order against that owner turn.
A selected question retains its preceding parts across the cutoff.
Existing service rows retain their identities and appear once, with complete
receipt text and origin restored when publication was truncated.
Competing question groups remain ambiguous and grant no authority. An opaque
chat key or owner ID alone cannot supply a topic; an unknown or conflicting
scope continues to require clarification. Settled and unrouted old receipts are pruned in
batches of at most 64 on sends and publication settlement. Expired pending
publications become terminal when visited; retained receipts remain available
for local context reads.
All new database waits use asynchronous admission and zero SQLite busy waits,
with named loop-monitor operations. No performance improvement is claimed.

## Operator-selected destination

The operator selected an automatic policy: use the connected Telegram bot
with the first enabled, install-answered target of an unpaused Celestia pairing.
Owner-tier targets lead; ties preserve the relay store's order. The operator
confirmed that the bots belong to the same owner. This policy requires no new
Celestia field or Delegatus setting; target ids remain opaque.

Celestia main `0997461ccf4d6e8752d03d3df2ed40ebc8187659` confirms that
`relay_protocol.py::_owner` emits `namespace: "telegram"` and the string of
`owner_telegram_user_id`. Delegatus's pairing confirmation preserves both.
The selected pairing's positive Telegram owner id is the review's private-chat
recipient. Section 6 P4 of the pinned Celestia design permits that recipient
when its owner-chat switch is on. That revision predates Part B. The service
now supplies
`POST /api/relay/v1/targets/{target_id}/messages`; a 404 still means the
endpoint or its switch is unavailable. The regression below exercises the
supported interface in isolated installs; it makes no production deployment claim.

Prototype publication uses this private destination instead of the project's
report group. Telegram confirms the recipient through `getChat`; a changed
pairing, paused relay or replaced connected bot cancels the send before it
starts. The review uses the existing durable send claim and does not grant
general agent posting permission in the private chat. Without a pairing or an
enabled target, it sends nowhere, and the relay panel shows why.
If the selected first target has no engine or model, it is absent from the
relay claim. Reviews stay off with an instruction to configure that target,
using the existing controls; a later target never silently replaces it.

Confirmed Telegram posts use the production publication hook with this same
target selection. The pairing's queue and cooldowns are shared across route
and instrumentation bundles. Replies with a known review reference still use
the web decision path, even when the selected target has owner tier off. This
narrow deterministic control launches no agent and grants no host access;
other text follows the target's existing answer profile.
Owner authority is checked against the current pairing while recording the
decision. The saved operator decision uses the web review's background delivery
worker, including its idempotent retry and recovery after Viewer restart.

## Immutable install capture

`src/lib/externalRelay/fixtures/relay_v1/install_owner_private_loop.json` is
generated by `src/lib/externalRelay/ownerPrivateLoop.test.ts`, using the
production destination selection, claim builder, sender, publish transport
and decision runner. The capture contains the owner-tier and ordinary-target
cases separately, with distinct request identities and the native poll posts.
The copied answer is decoded from the button in the actual Telegram request;
the private chat key is checked after schema parsing so it cannot silently
disappear from this regression.
An ordinary test run compares each complete captured payload to the checked-in case.
Regenerate only through that test by setting `LLV_RELAY_PRIVATE_LOOP_OUTPUT`
to the fixture path and running
`bash scripts/gate-slot.sh bun test src/lib/externalRelay/ownerPrivateLoop.test.ts`.
Use an isolated HOME, XDG configuration, state and temporary root, and a
closed loopback Viewer control URL, as required for all relay tests.

## Publication through a linked install

Bot-free links omit publication parts and keep their existing idle wire.
A single token-file existence check admits discovery when a bot is connected;
there is no discovery cache.

The optional `tp` part of the authenticated v1 board exchange carries at most
one receipt and one acknowledgement per call, in either direction. An older
peer ignores this part; the sender keeps its obligation. Both installs must
still share a project. Discovery advertises only the connected bot and the
selected production pairing's route and Telegram owner. The sender compares
the bot identity and verifies the receiving install's proof for that bot and
peer grant. A known local pairing must agree with the owner; a sender with no
local service pairing can use the receiving install's authorized pairing. It sends no receipt text before
that match. The first match pins the link, install and destination in
`relay_outbound_handoffs`; other peers and changed destinations cannot adopt it.
The sender's existing outbox keeps the original bot, chat, topic, message ID,
Telegram timestamp, text and provenance. Pairing credentials stay on the
receiving install. A handoff never calls Telegram. The receipt carries a
SHA-256 HMAC over its identity, attempt, destination and text, signed with
the connected bot token. The receiving install verifies it with its own bot
token and a constant-time comparison before publication and again after
waits. An authenticated board peer with only public bot and owner IDs cannot
manufacture receipts for that bot. The bot token is never transferred. Discovery is also signed with that token and
bound to the peer grant ID shared by both ends. The sender verifies this proof
before exporting any text; a proof copied from another link is refused.

Publication movement uses the existing sync burst schedule, including while
boards are closed; an otherwise idle link polls at most five minutes apart.
Each sync makes at most four publication exchanges. Each exchange attempts at
most one service request with the existing five-second deadline. Each handoff
candidate read visits at most 16 indexed rows and yields through asynchronous SQLite
admission. Skipped rows move behind a 30-second due time to let later rows
progress. Before dispatch, the sender persists its attempt and backoff; lost
responses and process restarts cannot reset the 64-attempt budget. The receiver
checks the live link, shared boundary, bot and frozen destination after waits
and at HTTP emission, and uses the existing publisher and credential store.
Celestia checks that the selected target and chat belong to that pairing.
Its idempotent `(chat_id, message_id)` insert supplies assistant provenance.
Peer input cannot supply owner flags, a model prompt or an owner identity.

A confirmed service response settles the sender as published. A 429 persists
the service's delay both at the receiver's pairing and in the sender's outbox.
A 400, 403 or 409 ends that receipt, with the status and bounded error code in
`relay_publication_results`. No credential or response payload enters the
journal. A transient refusal retries within the original 24-hour window.
Text beyond 12,000 Unicode code points is truncated deterministically with
`[truncated]`; JSON encoding also remains within 65,536 bytes. The full text
stays in the sending install's journal.

`src/lib/links/telegramPublication.test.ts` runs the real sender, pairing,
authenticated board route, sync client and publication transport in two
isolated processes. It runs with the sender on either side of the link. A
send is followed by a real sender restart, a publication with a lost response,
and another restart before replay. The service fixture stores one row and
serves it in the subsequent claim. The parsed relay input and actual answer
prompt include the report as `author.self: true`, followed by the human's
reply whose `reply_to` equals that report's service identity. The human is a
member with `is_owner: false`. Separate adversarial cases cover owner/bot
mismatches, revoked links, changed destinations, authority-bearing fields,
expiry, terminal refusals and durable cooldowns. This is context evidence
through the service wire, beyond the Telegram send receipt.

`evidence/telegram-publication-context.json` retains the actual parsed claims
and prompts from both directions, the stored-row and retry counts, and a
digest of the source files that produced them. Regenerate it by setting
`LLV_TELEGRAM_PUBLICATION_EVIDENCE` to that path when running the test above
in isolated state. Its clock and identifiers are synthetic.
