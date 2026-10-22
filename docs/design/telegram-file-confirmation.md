# Owner confirmation of one Telegram file send

## Observation on the starting main revision

The starting revision is `4da1e129`. No Telegram delivery was attempted in
this observation.

- `src/lib/telegram/bot/documents.ts:468` rejects a requested dot-directory
  path before loading a document. `:389` does the same in `readUnderRoots`.
- `src/lib/telegram/bot/documents.ts:347` rejects a resolved dot-directory;
  `:349` rejects the state directory; `:357` rejects paths outside configured
  document roots. The descriptor is checked again at `:401`.
- `src/lib/telegram/bot/documents.ts:501` rejects a text secret as
  `document_secret`, with its class and line, without returning its value.
- `src/lib/telegram/bot/service.ts:1413` loads documents, converts a
  `DocumentRefusal` to `TelegramBotError`, records a failed send and throws.
  Photos use `photoBlob` at `:1319`, which uses `readUnderRoots` at `:122`.
- `src/lib/telegram/bot/http.ts:62` returns the error message, code,
  `retryable: false`, and optional `secretClass`. Secret refusals use HTTP
  422; forbidden paths and outside roots use 403. The agent route catches
  them at `src/app/api/telegram/bot/agent/route.ts:77`.
- `src/lib/mcp/bindings.ts:5396` converts the document HTTP verdict into
  `McpToolRefusal`; `src/lib/mcp/server.ts:3497` returns the code and details
  through the MCP receipt. A repeated MCP request replays that refusal.

## Scope and shared paths

The producers are the operator bot route and the capability-attributed agent
bot route. MCP document and media bindings forward to the latter; internal
rich-message and generated-output senders use separate paths. Document roots
come from the bot store, with the host handoff directory as the default.
Both file kinds share the loader's path checks. The loader also serves relay
uploads and generated output, whose strict defaults must remain intact.

The transcript's Markdown renderer receives the confirmation URL from the
agent's reply. Its normal absolute-path branch opens local file previews, so
this exact application route navigates as an ordinary anchor. Document
Markdown, feed cards and user-message file links keep their existing resolver.
The shared loader's other consumers are relay attachments and intake uploads;
they omit the collector and keep strict path and secret refusals.

The new request and audit record belong to the Telegram bot service and store.
Only the owner confirmation route consumes a pending request; MCP receives
its link. Approval invokes the existing send and publication journals. No
approval field on an agent send grants authority. The confirmation binds
normalized send options, bot identity, file hashes, chat identity and topic.

The concurrent voice-approval lane owns the voice-tools contracts, seal,
store, HTTP gate, settings, shared operator authority, shared translations and
its evidence drivers. This change does not edit those files. It reuses the
existing paired-owner session verifier and browser perimeter.


## Behavior

A file detector refusal retains its code and adds `confirmation` over HTTP
and `details.confirmation` over MCP: `id`, a Delegatus-relative `url`, and
`expiresAt`. It authorizes no send. Open that URL in the same installation.
The paired installation owner signs in through the existing Telegram sign-in
surface, sees the full file hash, path, name, caption, chat, topic and detector
reasons, then chooses **Approve and send once** or **Do not send**.

The pending request owns a copy of normalized send options. Approval cannot
submit replacement options. The service reloads every file, runs its detectors,
checks all hashes and binds the canonical operation to its digest. Telegram
receives the immutable bytes checked by that reload. The existing bot selector
rechecks the live owner, chat permission, connected bot and expiry at its
transport boundary, including after its asynchronous membership checks. A chat
migration requires another confirmation. Owner sends use a namespace agent
send keys cannot claim.

Only secret, dot-directory and outside-roots detector refusals can offer this
confirmation. State-directory, regular-file, hard-link, descriptor, type,
size, decoding and chat restrictions still refuse. Strict loader consumers
never pass the warning collector, so relay uploads keep their existing policy.
An agent cannot supply approval in a tool argument or the agent route. The
owner route uses `companionOperator` and `authenticatedOwner`, requiring the
existing live Telegram session that matches the independently paired owner.
A bootstrap-only session, a service, an agent capability and an anonymous
browser are refused. No standing owner-DM exception is introduced.

The service holds at most 128 pending requests, for ten minutes each. A
bounded scan of those entries runs only on request, read or decision. The bot
SQLite database keeps the newest 256 confirmation audit records, including
approval time, outcome and message ids, without file contents. Small audit
writes refuse SQLite contention immediately. A failed audit write consumes
live authority before any dispatch; a repeated decision never resends. An
ambiguous delivery keeps an uncertain result and requires checking Telegram.
There is no automatic retry. No performance gain is claimed.

Audit records grant no authority. Their pending/approved states show as
unavailable after a Viewer restart; the agent must request a fresh send.
Restoring an audit row cannot recreate the service's private pending entry.
The existing member-session identity store remains the established local trust
boundary shared with the owner confirmation surface; this change does not
alter session enrollment or authentication.

## Verification procedure

Run heavy checks through `gate-remote -- <command>`, which exports the source
and isolates HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, with the Viewer
control URL on a closed port. Tests use FakeBotTransport and invented chats.
The first red run on `4da1e129`, with only the new service tests overlaid, was:

```sh
bun test --timeout=60000 src/lib/telegram/bot/service.test.ts -t 'confirmation|refused file'
```

All seven cases failed because no confirmation was offered. The initial MCP
confirmation propagation tests also failed before the bindings changed. The
four original path-safety cases that exposed changed refusal precedence
passed on the starting main revision; the final loader preserves them.

The focused checks are these explicit files, each in fresh isolated state:

```sh
bun test --timeout=60000 src/lib/telegram/bot/service.test.ts
bun test --timeout=60000 src/lib/telegram/bot/fileConfirmations.test.ts
bun test --timeout=60000 src/app/api/telegram/bot/confirmation/route.test.ts
bun test --timeout=60000 src/lib/mcp/telegramBot.test.ts
bun test --timeout=60000 src/app/api/telegram/bot/route.test.ts
bunx tsc --noEmit --incremental false
bun scripts/local-gate.ts pre-push
```

The existing conversation-window driver contains the rendered case. It covers
en/uk, light/dark and 1280×900/390×844, including pending, sent, rejected,
expired, uncertain, failed, unavailable and owner-sign-in states. The pending
case clicks the production approval control and verifies exactly one mock
send. Geometry and source hashes live in
`evidence/telegram-file-confirmation/geometry.json`; captures are private
artifacts. Reproduce with:

```sh
LLV_CONVERSATION_BROWSER_TEST=1 bun test --timeout=300000 src/components/conversation/conversationWindow.browser.test.tsx -t 'the file, destination, warnings and decisions'
```

The pre-push hook also selects adjacent contracts, store, schema parity,
MCP service and shared-loader tests. It runs without sending to Telegram or
accessing operator state. Publication is left to the pipeline.
