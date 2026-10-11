# Questions and prototypes inside Telegram messages

Status: research, 2026-10-11. Written by the architect stage of the task
"Questions and prototypes inside Telegram messages". Telegram facts were read
from the official Bot API pages on 2026-10-11 (Bot API **10.3**, released
2026-08-24) and checked by live sends with the connected Delegatus bot.
Delegatus code claims are at `328ab974a` on `main`; Celestia claims are at its
`origin/main` of 2026-10-11 (`cc9f5291a2`).

## Originating requirement

The operator, 2026-10-11 about 15:08 Kyiv, by voice in the seat chat, in
Russian, verbatim as pinned on the task:

> «исследую возможность пока что у нас есть только reach markdown message, и
> можно там запихнуть кнопочки, можно запихнуть туда карусельку, вот, то есть
> теоретически можно было бы свитчиться между этими... Прототипами и всем
> прочим. Только вот я не знаю, как это правильно сделать, потому что я так
> понимаю, что это Celestia нам, по идее, должна... или мы все в Celestia
> должны это встроить как часть её кода или что, потому что я бы хотел, чтобы
> это как-то было немножко проще... лучше всего, когда это будет прямо в
> телеге, прямо прототипы с кнопочками, в Telegram-сообщении... Но это надо
> исследовать, насколько это возможно, и поиграться с отправкой сообщения
> ботом реальным, с помощью токена, куда-то там... ко мне в чат, например, и
> проверить... есть кнопочки и посылания, возможно, есть кнопочки с
> коллбеками, вот, но как это сделать так, чтобы оно работало, хуй его знает.»

A teammate in the same thread: answering all Delegatus questions in Telegram
is the one thing that would really help.

The task asks for one recommended route for (a) answering Delegatus questions
and prototype-review questionnaires from Telegram and (b) viewing and
switching prototype variants inside a Telegram message.

## The answer in short

- **Everything the operator named exists in Telegram today and was sent for
  real**: rich Markdown messages, buttons inside the message text and under
  it, callback buttons, a swipeable carousel (`<tg-slideshow>`) inside one
  message, albums, and editing a sent message's picture, caption, text and
  buttons. All six test messages and both edits were accepted.
- **The blocker is who receives the button presses.** The bot Delegatus is
  connected to is also a Celestia clone. Telegram delivers every update of a
  bot to exactly one consumer, and for this bot it is Celestia's webhook. A
  press on a Delegatus button reaches Celestia, which has no handler for it,
  so the button spins and nothing reaches Delegatus.
- **Recommendation: Delegatus gets its own bot and handles the presses
  itself.** Celestia does not need to change. Delegatus already has the
  poller, the update store, the operator's Telegram identity and a path that
  hands a Telegram reply to the orchestrator seat; the press handler is an
  increment on that code. The operator's one action is to create a bot in
  @BotFather and paste its token into the Telegram panel.
- **First slice:** a prototype review published for a task with a Telegram
  destination arrives as one rich message: the frames in a slideshow, each
  question with its options as buttons (recommended marked), "Accept
  recommended" and "Open in Delegatus". Presses record the decision through
  the existing prototype-decision path and edit the message to show it.

## Prior work

- `search_transcripts` (project-scoped, then unscoped) for "Celestia webhook
  bot callback_query inline keyboard", "Telegram Mini App Delegatus prototype
  buttons" and "sendRichMessage slideshow rich message", and `search_memory`
  for "telegram bot webhook Celestia clone callback buttons": no earlier
  design of buttons, callbacks or prototypes in Telegram. The hits were this
  task's own seat message and unrelated Celestia keyboard work.
- `docs/design/telegram-bot-account.md` built the bot connection (Bot API
  over HTTPS from the Viewer, the token in the owner-only state directory,
  the allowlist, the three MCP tools). It already plans for "a webhook set by
  another service": the poller parks on `webhook_elsewhere`, never deletes
  that webhook, and the panel names the fix: "stop the other program, or give
  Delegatus its own bot".
- The same document's section "Replies to bridge reports" and
  `src/lib/telegram/bot/reportReplies.ts:86-122` admit an operator's Telegram
  reply to a bridge report and deliver it to the project's orchestrator seat.
  It only runs while Delegatus polls the bot.
- `docs/design/prototype-questionnaire.md` defined the questionnaire inside a
  prototype review (`PrototypeQuestion` in
  `src/lib/prototypeReview/types.ts:17-24`; the decision in
  `src/lib/prototypeReview/decision.ts:102`).
- `docs/design/relay.md` and its slices define the Celestia relay wire that
  this install speaks.

## 1. What Telegram allows today

Source: <https://core.telegram.org/bots/api> (the page names itself
"Bot API 10.3"), <https://core.telegram.org/bots/api-changelog> and
<https://core.telegram.org/bots/webapps>, fetched raw on 2026-10-11.

### 1.1 Rich messages — the "rich markdown message"

| Bot API | Date | What it added (changelog wording, shortened) |
| --- | --- | --- |
| 10.1 | 2026-06-11 | "Added support for Rich Messages, allowing bots to send highly structured text and stream AI-generated replies"; `sendRichMessage`, `sendRichMessageDraft`, `RichMessage`, `InputRichMessage`; "Added the parameter `rich_message` to the method `editMessageText`". |
| 10.2 | 2026-07-14 | Explicit blocks (`InputRichBlock*`), among them `InputRichBlockCollage`, `InputRichBlockSlideshow`, `InputRichBlockTable`, `InputRichBlockDetails`, `InputRichBlockPhoto`; `InputRichMessageMedia` for media referenced from Markdown/HTML. |
| 10.3 | 2026-08-24 | `RichMessageButton`, `RichTextButton`, `RichBlockButtons` / `InputRichBlockButtons` (buttons inside the message body); `DisabledButton`; `force_reply` on `InlineKeyboardMarkup`. |

- `sendRichMessage(chat_id, rich_message, reply_markup?, …)`. "Exactly one of
  the fields html, markdown, or blocks must be used" (`InputRichMessage`).
  `reply_markup` accepts an inline keyboard as well.
- Rich Markdown "is compatible with GitHub Flavored Markdown where possible
  and can contain arbitrary HTML": headings, lists, task lists, tables, block
  quotes, footnotes, formulas, `<details>` (collapsible),
  `<tg-collage>`, `<tg-slideshow>`, `<tg-button-row>` and inline
  `<tg-button>`.
- **Carousel**: `InputRichBlockSlideshow` — "A slideshow, corresponding to
  the custom HTML tag `<tg-slideshow>`", whose `blocks` are media blocks, with
  an optional caption.
- **Buttons inside the text**: `InputRichBlockButtons` — "a list of buttons
  that are shown in one row", "1-8 buttons". A `RichMessageButton` is one of
  `url`, `callback_data` ("1-64 bytes"), `web_app` ("Available only in private
  chats between a user and the bot"), `login_url`, the three
  `switch_inline_query*`, `copy_text`, or `disabled`; `style` is one of
  "danger", "success", "primary" or "link".
- Media: "Media blocks support only HTTP and HTTPS URLs", or `tg://photo?id=`
  links resolved through the `media` field, which can "reuse previously
  uploaded files or upload a new file".
- Limits ("Rich Message Limits"): 32 768 characters, 500 blocks, 16 levels of
  nesting, 50 media attachments, 20 table columns.

### 1.2 Inline keyboards and callbacks

- `InlineKeyboardMarkup.inline_keyboard`: rows of `InlineKeyboardButton`
  (`callback_data` 1–64 bytes, `url`, `web_app`, `copy_text`, `disabled`, …,
  plus `style`). New in 10.3: `force_reply` — "the reply interface must be
  shown to the user, as if they had manually selected the bot's message and
  tapped 'Reply'".
- A press on a callback button produces an update with a `CallbackQuery`
  (`id`, `from`, `message`, `data`). "After the user presses a callback
  button, Telegram clients will display a progress bar until you call
  `answerCallbackQuery`." `answerCallbackQuery` can show a toast or an alert
  (0–200 characters).

### 1.3 Editing a message in place

- `editMessageText` edits "text, rich and game messages"; `rich_message` is
  the new rich content; `reply_markup` replaces the inline keyboard.
- `editMessageMedia` replaces the picture of a photo message, or "a text or a
  rich message with a media", with a new inline keyboard.
- `editMessageCaption` and `editMessageReplyMarkup` edit the rest.

So "switch between variants by pressing a button" is: on the callback, call
`editMessageMedia` (photo message) or `editMessageText` (rich message), then
`answerCallbackQuery`.

### 1.4 Albums (media groups)

`sendMediaGroup` sends "a group of photos, live photos, videos, documents or
audios as an album", 2–10 items. It has **no `reply_markup` parameter**, so an
album cannot carry buttons; a choice needs a separate message. The rich
slideshow (§1.1) has no such limit.

### 1.5 Mini Apps (Web Apps)

- An inline `web_app` button opens an HTTPS page inside Telegram (private
  chats only). The page receives the user's identity and a `query_id`; the bot
  can answer with `answerWebAppQuery`.
- "To validate data received via the Mini App, one should send the data from
  the `Telegram.WebApp.initData` field to the bot's backend … secret_key =
  HMAC_SHA256(<bot_token>, "WebAppData")". Whoever holds the bot token can
  verify who opened the page; no update needs to be received for that.
- 10.2: Mini App methods are refused from origins other than the Mini App's
  own domain (on by default since 2026-07-20).

### 1.6 One consumer of updates per bot

`getUpdates`: "This method will not work if an outgoing webhook is set up."
`setWebhook`: "You will not be able to receive updates using getUpdates for as
long as an outgoing webhook is set up." A bot has exactly one place its
updates go: a webhook, or one long-polling reader. That place receives every
callback query.

### 1.7 Not needed here

Ephemeral messages (10.2/10.3, visible only to one user in a group), guest
mode (10.0) and streaming drafts (`sendRichMessageDraft`) exist. None is
needed for a private chat with the operator.

## 2. What the live test showed

Six messages were sent to the operator's private chat with the connected bot,
each labelled "🧪 Delegatus · дослідницький тест N/5" (the sixth "доповнення"),
in Ukrainian, the operator's interface language. They went straight to the
Bot API with the token Delegatus holds (the token was read inside the sending
process and never printed). `telegram_bot_send` and `telegram_bot_send_media`
were not used: they take plain text or Telegram's HTML subset and have no
`reply_markup`, rich-message or edit parameter. Nothing was deleted, and the
webhook was only read (`getWebhookInfo`), never changed.

| # | Method | What it showed | Result |
| --- | --- | --- | --- |
| 1 | `sendRichMessage` (Markdown) | A questionnaire: headings, a table of options with the recommended one marked, a task list, a collapsible `<details>` block, a `<tg-button-row>` of three callback buttons (one `success` style) and a row with a `web_app` button. | Accepted. Telegram returned the parsed blocks: heading, paragraph, heading, table, buttons, heading, list, details, buttons, divider, paragraph. |
| 2 | `sendMessage` (HTML) + `reply_markup` | The classic form: three answer buttons, "Skip (accept recommended)", a `copy_text` button, a `disabled` button, and `force_reply`. | Accepted; the keyboard came back as sent. |
| 3 | `sendPhoto` + inline keyboard, then `editMessageMedia` | A prototype frame "Variant 1" with ◀ 1/3 ▶, variant numbers and "Pick variant 1". Four seconds later the test itself did what a press handler would do: replaced the picture with "Variant 2", changed the caption and moved the keyboard to 2/3. | Both calls accepted. Switching variants in place works. |
| 4 | `sendMediaGroup` | The three frames as one album with captions. | Accepted (three messages, one album). No buttons possible (§1.4). |
| 5 | `sendRichMessage` with `<tg-slideshow>`, then `editMessageText(rich_message)` | The carousel the operator asked for: the three frames in one swipeable slideshow inside one message, captions per frame, a row of pick buttons under it. The images reused the album's uploads by `tg://photo?id=` + `media`. The test then edited the message to add a quoted "edited" line. | Both accepted; the slideshow came back with 3 frames; the edit returned the new blockquote block. |
| 6 | `sendRichMessage` with an uploaded image | A frame uploaded in the same call (`media: [{id, media: "attach://…"}]`, multipart) instead of reusing an earlier upload, and a closing note explaining why presses spin. | Accepted (photo block). A review can send its frames in one call. |

What the test could **not** show from here:

- **Presses.** No callback reaches Delegatus (§3). A press on any test button
  goes to Celestia and the button spins until the client gives up. Pressing
  is still harmless: Celestia has no handler for the `dlgtest:` data.
- **How each client renders the messages.** The API accepted every block and
  returned it parsed; what the phone shows is for the operator to look at. If
  a client renders the slideshow or the in-text buttons badly, the
  inline-keyboard form (messages 2 and 3) is the proven fallback.
- **Whether the `web_app` button opens its page.** The API accepted a button
  to a page on another domain; opening it is a tap on the phone.

One side effect to know: message 2 asked for a reply (`force_reply`). A typed
answer in that private chat goes to Celestia, whose hosted AI may answer it
(§3.2).

## 3. Who receives the bot's updates today

### 3.1 The webhook belongs to Celestia's clone gateway

- `getWebhookInfo` (read-only), 2026-10-11: the webhook host is Celestia's
  origin (the one in `src/lib/externalRelay/knownRelays.ts:17`), the path has
  the shape `/telegram/webhook/<hash>`, `pending_update_count` is 0, and
  `allowed_updates` includes `callback_query`.
- Celestia registers that URL for every active clone bot:
  `apps/backend/tgbot/webhook/gateway.py` `_reconcile_active_clone_webhooks`
  calls `set_webhook(url = external_url + clones_webhook.path_prefix +
  token_hash, allowed_updates = …)` at startup, and
  `application/usecase/clones/activate_clone.py` does the same on activation.
  The route `path_prefix/{token_hash}` is served by `handle_clone` in
  `tgbot/webhook/nats/handler.py:1046`, which feeds the update into Celestia's
  own processing. So the bot Delegatus is connected to is **also a Celestia
  clone**, and the relay target named "Delegatus" answers through it.
- Consequence: every press on a button Delegatus sends is delivered to
  Celestia. Celestia's handlers match only their own callback data, so a
  Delegatus press is dropped. Any setWebhook Delegatus made would be undone
  by Celestia's reconcile on its next start, and would cut the clone off.

### 3.2 The relay does not carry presses, and does not relay private chats

- The relay v1 answer is text only: `Answer = { action: "reply" | "ignore",
  text, reply_to }` (`apps/backend/api/schemas/relay_v1.json`). A request is
  built from chat messages (`Input.conversation`, `request_text`); there is no
  event kind for a button press and no field for a keyboard.
- Celestia dispatches to the relay only for group chats:
  `_is_regular_group_relay_candidate` in `aiinit/controllers/prepare_answer.py`
  requires `chat_id < 0`. A message the operator types in the private chat
  with the bot is answered by Celestia's hosted path and never reaches
  Delegatus.

### 3.3 Delegatus is post-only on this bot

- `src/lib/telegram/bot/service.ts:447-450` parks the poller on
  `webhook_elsewhere`; `telegram_bot_chats` reports exactly that for this bot.
- The poller asks only for `["message", "edited_message", "channel_post",
  "edited_channel_post", "my_chat_member"]` (`service.ts:136`); even with
  polling, callback queries would not be requested.
- What already exists for the polling case (`service.ts:643-662`): durable
  intake (`store.applyUpdates`) before the offset moves, operator replies to
  bridge reports admitted and delivered to the seat
  (`admitReportReplies` / `drainReportReplies`), and Telegram sign-in answers.
  The operator's Telegram identity is the team owner's linked account
  (`reportReplyOperatorId`, `reportReplies.ts:34-37`).

## 4. Ownership options

| | Option | What it takes | Trade-offs |
| --- | --- | --- | --- |
| **A** | **Delegatus gets its own bot and handles callbacks** | The operator creates a bot in @BotFather and pastes the token in the existing Telegram panel; the operator writes /start to it once. Delegatus polls it (no public URL needed). Add `callback_query` to `ALLOWED_UPDATES`, a press handler beside `admitReportReplies`, and a sender for rich messages and edits. | **For:** no cross-repository change; every part of a round (sending, presses, edits, decision) lives in the program that owns the reviews; polling works behind NAT and in the Docker install; report replies start working too. **Against:** a second bot in the operator's Telegram; per-project Telegram destinations must point at chats where the new bot is a member. |
| A′ | Move the current bot out of Celestia | Deactivate the clone in Celestia so its webhook goes away; Delegatus polls it. | Same code as A and no new bot, but the Celestia clone and its relay target stop answering in the groups it serves. Only sensible if that clone is no longer wanted. |
| B | Celestia forwards presses over the relay | A new relay feature (a "callback" request kind with the callback id, data, user and message), Celestia routes clone callbacks with a Delegatus prefix into it, Delegatus answers and edits. Both repositories, wire versioning, fixtures, and both sides' review. | Keeps one bot. But the relay is pull-based (the install claims leased requests), so a press waits for the next claim while Telegram shows a spinner; it carries AI answer requests and has no event for a UI press; private chats are not relayed today; and Celestia would have to learn which messages are Delegatus's. Heavier than the problem, and it ties Delegatus's review UI to another product's release cycle. |
| C | Mini App opened from a button | A `web_app` button opens a Delegatus page inside Telegram; the page checks `initData` with the bot token (Delegatus holds it, so this works even while Celestia owns the webhook) and posts the answers straight to Delegatus. | Works without receiving any update. But the page must be reachable over HTTPS from the phone: today that is the tailnet address (only on devices in the tailnet) or a public entry Delegatus does not run by default; and a page that re-renders the review is the web UI again in a smaller window. It does not put "prototypes with buttons in the Telegram message". |
| D | Deep link back to the Delegatus web UI | A `url` button "Open in Delegatus" on every Telegram post, to the task's review. | No new infrastructure, works today. Same reachability caveat as C, and the answer is given in the web UI. It suits a companion button; on its own it leaves the answering in the web UI. |

Why not "build it into Celestia": the questions, prototype rounds, decisions
and the orchestrator that waits for them all live in Delegatus. Celestia would
only be a mailbox for presses, and its mailbox (the relay) is shaped for
something else. The operator's wish for something simpler is A: one bot, one
program, nothing to coordinate.

## 5. Recommendation

**A — a dedicated Delegatus bot that Delegatus polls, with D's link on every
post.** It is the only option that gives the operator what was asked
(prototypes with buttons in the Telegram message, answers by pressing) with
code in one repository, most of which exists. A′ is the same build with the
current bot, if the operator decides the Celestia clone can go; the build does
not depend on which token is pasted.

## 6. First slice and its acceptance

**Scope: prototype reviews only** (they already carry questions, options, the
recommended mark and frames). Other Delegatus questions come in slice 2.

1. **Receive presses.** Add `callback_query` to `ALLOWED_UPDATES`
   (`src/lib/telegram/bot/service.ts:136`). In `pollOnce`, beside
   `admitReportReplies`, admit a callback only when `from.id` is the linked
   operator (`reportReplyOperatorId`), the message is one Delegatus posted for
   a review round (a stored post-receipt keyed by chat and message id), and the
   data parses as a round-scoped token of at most 64 bytes (a short round key,
   a question index and an option index; never a task id or name). Persist it
   before the offset moves, as report replies are; answer every callback query,
   including refused ones, with a short toast.
2. **Post the round.** When a prototype review is published for a task whose
   project has a Telegram destination (`effectiveReportTelegram`, the same
   setting bridge reports use), send one `sendRichMessage`: title, the frames
   uploaded in the same call inside `<tg-slideshow>` with "N · name" captions,
   then per question a short heading and its options as a `<tg-button-row>`
   (recommended option styled `success` and marked ✅; multi-select options
   toggle with a ☐/☑ prefix), then "Accept recommended" and "Send", and a
   `url` button "Open in Delegatus". A round with more questions or options
   than fit (8 buttons per row, 64-byte data) falls back to the link only.
3. **Show the state by editing.** Each press re-renders the same message with
   `editMessageText(rich_message)` so the chosen options show; "Send" and
   "Accept recommended" record the decision through the existing
   `decidePrototype` path (`decision.ts:102`), same answers shape
   (`PrototypeAnswer`), same delivery to the orchestrator, then edit the
   message to a closed "Answered: …" state without buttons. A round already
   decided in the web UI edits the Telegram message the same way, and a press
   on it is answered "already decided". `decidePrototype` takes a request for
   the operator's authority and the seat delivery; the press handler needs an
   operator-authority entry that is not an HTTP request from a browser, which
   is the one seam the build must design with care.
4. **Free text.** The comment field is not in the message. A plain reply to
   the review post is admitted like a report reply and attached to the round
   as its comment, the same way `admitReportReplies` matches a reply to a
   posted report.

**Acceptance**

- Unit tests with the fake transport (`fakeTransport.ts`), no network: a press
  by the linked operator on a live round records exactly the answer the web UI
  would record for the same choices, once, across a replayed update batch and
  a restart; a press by anyone else, on a decided round, with malformed or
  oversized data, or on a message Delegatus did not post is refused, answered
  with a toast, and records nothing; every callback query gets exactly one
  `answerCallbackQuery`.
- A rendering test of the rich Markdown for a fixture round (3 variants, 2
  questions, one multi-select) checks the limits of §1.1 and the fallback to
  the link.
- A live check on the operator's phone with the new bot: a test review with
  3 frames and 2 questions arrives as one message; swiping the slideshow shows
  the three frames; pressing options marks them; "Send" delivers the decision
  to the orchestrator and the message turns to "Answered"; the same round in
  the Delegatus web UI shows the same decision.
- The connection panel shows "polling" for the new bot; Celestia's bot and
  its webhook are untouched.

## 7. Next slices

- **Slice 2: other questions.** A stage that ends `needs_decision` and an
  orchestrator `question` report post the question with one button per
  option and the recommendation marked; a press steers the seat like a report
  reply does today. This needs a structured options field on those questions;
  today they are prose, and a reply is the only answer path (it starts working
  with A at no extra cost).
- **Slice 3: variant switching on a photo message** (message 3 of the test)
  for clients where the slideshow does not suit, using `editMessageMedia`.

## Validation against the requirement

- "rich markdown message … кнопочки … карусельку … свитчиться между
  прототипами": §1.1 and test messages 1, 3 and 5 show all of it, live.
- "кнопочки с коллбеками … как сделать так, чтобы оно работало": §3 names why
  they do not work today and §5 how they will.
- "Celestia нам … должна, или мы всё в Celestia должны встроить … хотел бы
  проще": §4 B and the paragraph after the table; the recommendation needs
  nothing from Celestia.
- "прямо в телеге, прямо прототипы с кнопочками, в Telegram-сообщении": the
  first slice is exactly that for prototype reviews.
- The teammate's "answer all Delegatus questions in Telegram": slice 2, and
  plain replies to reports start working as soon as Delegatus polls its bot.

## Deferred — not currently justified

- **A Mini App** (§4 C). It needs an HTTPS entry reachable from the phone and
  rebuilds the web UI in a webview; the message itself already shows frames
  and takes answers.
- **A relay extension for presses** (§4 B). Cross-repository, latency-bound,
  and it solves a problem a second bot removes.
- **Webhook mode for the Delegatus bot.** Polling needs no public URL and is
  what the poller already does.
- **Ephemeral messages, groups and forum topics for reviews.** The operator
  answers in a private chat; group delivery can follow when a team asks.
- **Streaming drafts (`sendRichMessageDraft`)** for questions. Nothing here
  streams.
- **Changing `telegram_bot_send` to accept arbitrary `reply_markup` or rich
  content for agents.** Buttons whose presses only Delegatus can interpret
  belong to the feature that handles them; an agent's free-form post has no
  handler behind its buttons.

## Open points for the operator (none blocks the design)

1. Which bot: a **new** bot for Delegatus (recommended; Celestia keeps its
   clone), or move the current bot out of Celestia (A′).
2. The project's Telegram destination for reviews: the private chat with the
   new bot (recommended for the first slice) or a team group.
