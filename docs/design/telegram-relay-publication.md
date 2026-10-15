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
429 cooldowns. A 404 holds the target for five minutes; a 403 holds its chat
for five minutes. Before replay and again after DNS, the emission guard checks
the connected bot, pairing, target, owner and posting policy. Revocation leaves
the obligation pending. The idempotent service endpoint receives the original
Telegram identity and text after a restart. Recovery never sends to Telegram.
Uncertain Telegram sends retain their original send claim without inventing a
receipt. Posts made without a selected pairing remain locally recorded and
unrouted; a later pairing cannot adopt them automatically.

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
priority even when its service-history row is missing. Otherwise the latest question group and recent local context
since the preceding owner turn appear before the unthreaded answer, with their
full options and source attribution. Repeated request IDs reuse their persisted
owner-turn cutoff. Existing service rows retain their identities and appear once, with complete
receipt text and origin restored when publication was truncated.
Competing question groups remain ambiguous and grant no authority. An opaque
chat key or owner ID alone cannot supply a topic; an unknown or conflicting
scope continues to require clarification. Settled and unrouted old receipts are pruned in
batches of at most 64 on sends and publication settlement; pending publication custody survives retention expiry.
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
when its owner-chat switch is on. That main revision has no publish route yet;
404 remains the expected unavailable outcome until Celestia ships Part B.
No deployed-switch or live private-loop success is claimed here.

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
