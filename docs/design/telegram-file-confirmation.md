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

MCP document and media bindings produce file sends through the capability-
attributed agent bot route. The owner confirmation route invokes the same
service methods with private approval context. The operator bot route writes
the root and chat settings those sends read. Document roots come from the bot
store, with the host handoff directory as the default. Both file kinds share
the loader's path checks. Internal rich-message and generated-output senders
use separate paths.

The transcript's Markdown renderer receives the confirmation URL from the
agent's reply. Its normal absolute-path branch opens local file previews, so
this exact application route navigates as an ordinary anchor. Other local file
links keep their existing resolver. The shared loader's other consumer is
`src/lib/externalRelay/attachments.ts`: outgoing attachments omit the collector
and keep strict path refusals; private generated output uses `readExactFile`.
Its text attachments still run the existing secret scanner.

The new request and audit record belong to the Telegram bot service and store.
Only the owner confirmation route consumes a pending request; MCP receives
its link. Approval invokes the existing send and publication journals. No
approval field on an agent send grants authority. The confirmation binds
normalized send options, bot identity, requested and resolved file paths, file
hashes, chat identity and topic.

The concurrent voice-approval lane owns the voice-tools contracts, seal,
store, HTTP gate, settings, shared operator authority, shared translations and
its evidence drivers. This change does not edit those files. It reuses the
existing paired-owner session verifier and browser perimeter.


## Behavior

A file detector refusal retains its code and adds `confirmation` over HTTP
and `details.confirmation` over MCP: `id`, a Delegatus-relative `url`, and
`expiresAt`. MCP expands the validated route to an absolute URL using the
installation's saved public address, or its local control origin when none is
saved, so an agent can relay a clickable link over Telegram. An untrusted
response cannot choose a different route or origin. It authorizes no send.
The paired installation owner signs in through the existing Telegram sign-in
surface. The page follows the operator's choice of 2026-10-27, variant 2
«warning first» of the prototype review: the strongest detector reason is the
heading (a secret, else a hidden folder, else the folders outside the document
roots), and a sentence names the agent's request, the chat and, when the
requested name is a link, the file the bytes really come from. The other
reasons follow as a short list. The primary answer is **Don't send**; **Send
once anyway** is the secondary answer, drawn in the warning colour. Every word
comes from the stored view (`fileConfirmationSummary` in
`src/lib/telegram/bot/fileConfirmationContract.ts`). The state is a dot beside
the card's first row whose popover says it in words with its deadline or
decision time. The full file hash, both paths, size, caption, chat and chat id,
topic, reply-to message, caption format, silent-delivery choice, allowed
folders, detector codes, request id, times and digest sit one tap away in the
closed **Details** fold. While a decision is in flight the card stays, both
answers are disabled and the pressed one says **Sending…** or **Declining…**.
A completed, expired or refused request opens with its outcome as the heading
and offers no answer. Sending and decision results return the view to the top
so the owner can read that state.

The pending request owns a copy of normalized send options. Approval cannot
submit replacement options. The service reloads every file, runs its detectors,
checks all hashes and resolved locations and binds the canonical operation to
its digest. A symlink retarget requires a new confirmation even if its new
target has identical bytes. Telegram receives the immutable bytes checked by
that reload. The existing bot selector
rechecks the live owner, chat permission, connected bot and expiry at its
transport boundary, including after its asynchronous membership checks. A chat
migration requires another confirmation. Owner sends use a namespace agent
send keys cannot claim.

Only secret, dot-directory and outside-roots detector refusals can offer this
confirmation. State-directory, regular-file, hard-link, descriptor, type,
size, decoding and chat restrictions still refuse. A hard refusal after a
collected detector warning keeps the hard failure's code and reason and offers
no confirmation. Strict loader consumers never pass the warning collector, so relay uploads keep their existing policy.
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

The existing conversation-window driver contains the rendered cases, one per
width and language: 390×844 under a touch pointer and 1440×900, en and uk,
light and dark, in the states pending, details (the fold open), status (the
dot's popover open), sending (the decision held in flight), sent, rejected,
expired, uncertain, failed, unavailable and owner sign-in; plus 820×900
pending in both languages, and two images and 70-character names at 390 in
uk. The pending fixture uses a report-named symlink to a hidden credential
file. Pressing the production answers must post exactly
`{ id, digest, approve }` once and leave no answer on the page. Before any
scroll the heading, both answers and the real file are whole on the first
screen. Each frame also checks text against the window and clipping ancestors,
ellipses, 44 px touch and 24 px pointer targets, the popover's place inside
the card and off every word, the dot on the Details chevron's centre line,
4.5:1 answer contrast, no ISO timestamp and no Latin word in a Ukrainian frame
outside names and code tokens.
Geometry and source hashes live in
`evidence/telegram-file-confirmation/geometry.json`; captures are private
artifacts. Each case judges its own frames, so any one runs alone by `-t`;
the file is rewritten only after a run in which every case passed.
Reproduce with:

```sh
LLV_CONVERSATION_BROWSER_TEST=1 bun test src/components/conversation/conversationWindow.browser.test.tsx -t 'owner confirmation of one Telegram file send'
```

The pre-push hook also selects adjacent contracts, store, schema parity,
MCP service and shared-loader tests. It runs without sending to Telegram or
accessing operator state. Publication is left to the pipeline.
