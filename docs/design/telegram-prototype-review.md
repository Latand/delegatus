# Prototype reviews in Telegram through Celestia

Implementation update, 2026-10-15: decision forms now add advisory native polls
below the media post. The authenticated owner's text reply decides. The relay
receives each outgoing poll's reference and numbered options, so a direct reply
can identify its round from the parent message. The original design below is
retained as the record of the earlier copy-line flow.

Poll work runs separately from form publication in the shared bot service,
with at most 16 queued forms and seven polls per form. Sends are serial and each
has a five-second deadline. A durable pending claim becomes uncertain after an
interruption; it is never resent automatically. Every outcome stays in the local
round, and failures join the orchestrator's existing Telegram wake signals.
Admitting a poll job persists an empty poll ledger before its first send, even
while it waits behind another form. Recovery requires a ledger matching the
publication key; older forms with no ledger stay unchanged and raise no poll alert.
Poll metadata changes one task row and its cache revision while preserving its
editor, timestamps and linked group stamps. Board answers leave polls alone.
Questions exceeding the option count stay text-only. Full text remains in the
form; poll questions and options shorten with an ellipsis under the
[Bot API limits](https://core.telegram.org/bots/api#sendpoll).

Status: design, 2026-10-11. Written by the architect stage of the task
"Prototype reviews in Telegram through Celestia". Delegatus claims are at
`e7893bcfa` on `main`. Celestia claims are at its `origin/main` of 2026-10-11
(`cf5ff1750`), read from a scratch clone; nothing in the Celestia repository
was changed. Celestia paths below are written `C/…` relative to that
repository's root. Telegram facts were read raw from
<https://core.telegram.org/bots/api> (the page names itself "Bot API 10.3") on
2026-10-11.

Verdict of this stage: **pass, build the Delegatus half now** (seat decision
of 2026-10-11, §7). It works today in every group where the clone answers
through this install. The operator's private chat with the clone, which is
where this project's reports and reviews go, never reaches Delegatus, and only
a Celestia change opens it (§6). The private-chat route is asked of the
operator separately; this lane changes neither the report chat nor Celestia.

## Originating requirement

The operator, 2026-10-11 about 15:45 Kyiv, by voice in the seat chat, in
Russian, verbatim as pinned on the task, after the research lane recommended
a separate Delegatus bot:

> «Не, не, не. ... нужно сделать так, чтобы он всё-таки работал через
> [Celestia] ... Можно тогда без кнопок, можно показывать прототипы, как вот
> этот слайд-шоу, да? С описанием, Rich Markdown, вариант классный был ... вот
> вариант дослідницький тест 5 ... Ещё вот это есть, Rich Markdown первый
> тест, который там, где вопросы ... О, кстати, у нас же есть там же
> кнопочки. Скопировать короткий ответ. Да, у нас есть такое и в композере,
> короткий ответ. А ещё у нас есть в Телеграме, есть возможность такую кнопку
> сделать ... можно и сделать, что типа 3 варианта, и скопіювати відповідь,
> да. А в відповіді може бути ответ. На вопросы, все вот эти рекомендуемые. И
> дальше человек просто в ответе текстом отправляет делегатусу ответ, своему
> вот этому клону, и оно всё равно ж попадает на тот... где делегатус
> работает. Поэтому, в принципе, текстом он и обработает этот прототип.
> Просто надо сделать так, что типа раз он... это прототип отправил, чтобы он
> понимал, что раз это ответ на прототип, чтобы было видно, что там прототип
> показан, и описаны варианты, чтобы из контекста было понятно, на что это
> ответ ... И дальше, как бы, оно работает в штатном режиме ... Поэтому можно
> отправлять такое сообщение, а [Celestia] и так уже обрабатывает, понимаешь?
> Или может надо проверить, правильно ли обрабатывает.»

Pinned outcome, shortened: (1) a published round goes to the project's report
chat as one rich message: slideshow with variant numbers, names and one-line
descriptions, questions with the recommended answer marked, the title and a
short reference, and copy-text buttons «Скопіювати рекомендовані» plus one per
variant, each copying a short answer that names the review; (2) the owner's
text to the clone reaches this Delegatus through the existing Celestia relay
owner path and records the decision through the web decision's path, so the
seat gets the usual «Prototype review decision»; deterministic recognition of
the reference; a text naming no known waiting round is a normal message;
(3) first, observe whether that path exists, and stop with a precise ask if
Celestia must change.

## The answer in short

- **Groups work today.** In a group where the clone answers through this
  install (a relay chat), the owner's message reaches Delegatus as an owner
  request, with the message text intact. This install has recorded such
  owner requests and owner-tier runs.
- **The private chat does not.** Celestia sends a request to the relay only
  for group chats; the owner's private chat with the clone is always answered
  by Celestia's own hosted AI (§2.1). The Delegatus project's report
  destination is that private chat (§2.4).
- **Nothing Delegatus posts through the bot token is visible to Celestia.** A
  reply to the review message arrives with no link to it and no quote of it
  (§2.3). So the copied answer has to carry the reference itself, which the
  pinned outcome already asks for.
- **Design:** post one rich message (layout of research tests 1 and 5) with
  copy-text buttons whose text is a single line naming the round by a short
  reference `#proto-xxxxxxxx`. In the relay runner, before an owner request
  launches an agent, a pure parser recognises that reference against this
  install's waiting rounds and records the decision through `decidePrototype`
  with an in-process operator sender; the clone replies with a one-line
  confirmation. Anything else runs as today.
- **Decided (§7):** build the Delegatus half now. Whether Celestia relays
  the owner's private chat (§6) or reports move to a relay group is asked of
  the operator separately.

## Prior work

- `search_transcripts` (project-scoped, then unscoped) for "Celestia relay
  private chat owner clone chat_id < 0 not relayed" and "tg-slideshow
  figcaption дослідницький тест 5", and `search_memory` for "Celestia relay
  owner private chat clone telegram reply prototype": no earlier design of
  answering prototype reviews through the relay. The hits were this task's
  own seat message, the research lane's transcript (the live-test sources
  quoted in §4.1) and unrelated Celestia work.
- `docs/research/telegram-questions-and-prototypes.md` (research lane, on its
  own branch): Bot API 10.3 rich messages, slideshow and in-text buttons; the
  six live sends; the clone's webhook belongs to Celestia, so callback buttons
  never reach Delegatus. Its §3.2 claim "Celestia dispatches to the relay only
  for group chats" was re-checked against newer Celestia code and holds
  (§2.1).
- `docs/design/relay-owner-tier.md`: the owner tier. Its originating
  requirement asks for the owner to be served "everywhere the clone may answer
  with AI, when the owner writes"; the private chat is the one place that does
  not happen today, which §6 would close as a side effect.
- `docs/design/prototype-questionnaire.md` and `src/lib/prototypeReview/**`:
  rounds, questions, the decision and its delivery to the seat.
- `src/lib/telegram/bot/reportReplies.ts:40-45`: an operator message from
  Telegram delivered to a seat in process, with `origin: { kind: "operator" }`
  and no HTTP request. The in-process sender of §4.5 reuses that shape.

## 1. What the flow needs

1. Delegatus posts the round to the project's report chat through the bot
   token (the bot is the clone; Delegatus may post as it).
2. The owner copies a short answer and sends it to the clone.
3. Celestia hands that message to this install as a relay request.
4. Delegatus recognises the reference, records the decision, and the seat
   gets the usual message.

Steps 1 and 4 are Delegatus code. Step 3 is the one that had to be observed.

## 2. Observation (step 3 of the task)

### 2.1 Which of the owner's messages reach Delegatus

| Where the owner writes | Reaches Delegatus? | Evidence |
| --- | --- | --- |
| A group where the clone answers through this install, replying to a bot message or mentioning the bot | **Yes**, as a relay request with the requester block | Dispatch requires `answer_source == RELAY`, a pairing and `_is_regular_group_relay_candidate` (`C/apps/backend/aiinit/controllers/prepare_answer.py:1981-1986`), then the per-chat switch `relay_fallback.chat_enabled` (`:1987-1990`; the row must say the install answers, `C/apps/backend/infrastructure/database/repo/relay.py:469-480`). A reply to any message from the bot triggers the AI when the group's `reply_to_bot_messages_enabled` is on (`C/apps/backend/tgbot/handlers/groups/ai/ai_filters.py:90`). |
| A group message that neither replies to the bot nor mentions it | No; Celestia's AI is not triggered | Same filters. A copied answer pasted as a fresh message in a group needs a reply or a mention. |
| **The owner's private chat with the clone** | **No, never** | `_is_regular_group_relay_candidate` requires `request.chat_id < 0` (`prepare_answer.py:206-213`); a private chat has a positive id. `relay_fallback.enqueue` refuses one outright: `if request.chat_id >= 0: raise ValueError("Relay Slice A accepts regular group replies only")` (`C/apps/backend/application/usecase/clones/relay_fallback.py:96-101`). The message is answered by Celestia's hosted path. Celestia's own plan says the same (`C/docs/design/relay-full-integration-plan.md:34`: "Relay is selected for eligible regular group requests"). |

`is_owner` is `user_id == owner_id`, the clone's owner
(`C/apps/backend/application/usecase/clones/relay_requester.py:34`); the
owner is admitted without a membership check
(`C/apps/backend/application/usecase/clones/relay_requester_context.py:95-110`).
On this side, `ownerTierFor` grants the owner path only when the target's
`ownerTier` switch is on, the requester block says `is_owner` and not an
anonymous admin, and the message being answered was written by that requester
(`src/lib/externalRelay/profile.ts:13-20`).

### 2.2 What fields arrive

The request's `input` (`src/lib/externalRelay/protocol.ts:94-137`; built by
`C/apps/backend/application/usecase/clones/relay_answer_input.py:70-267`):

| Field | Content | Notes |
| --- | --- | --- |
| `conversation[]` | Up to 40 stored messages: opaque `id`, `author { key, name, self }`, `sent_at`, `text`, `reply_to` | `text` is the stored text plus a media description (`relay_answer_input.py:137-188`). The trigger and the message it replies to are mandatory when present in history (`:89-128`). |
| `respond_to` | The opaque id of the trigger (the owner's message) | `ownerTierFor` reads the trigger's text from here. |
| `request_text` | Command text, when the AI was invoked by a command | Null for a plain reply. |
| `requester` | `key`, `is_admin`, `can_restrict_members`, `can_delete_messages`, `is_anonymous_admin`, `is_owner` | Present when the pairing claims requester context; this install does. |
| `chat.key` | An opaque per-chat key | No chat type, no chat id, no topic. |

What does **not** arrive: the chat type, the Telegram quote the owner
selected (stored by Celestia as metadata, `C/apps/backend/tgbot/middlewares/parsers.py:110-121`,
and never exported to the relay), and the message the owner replied to when
that message is one Delegatus sent (§2.3).

How the owner's text is stored: `extract_authored_text` → `extract_markdown_text`
converts the message's HTML form to Markdown
(`C/apps/backend/infrastructure/tgbot/utils.py:7-25`). Run through Celestia's
own converter (its `chatgpt_md_converter.html_to_telegram_markdown`, read-only
from its environment), the answer line of §4.3 comes back byte for byte;
`*x*` becomes `_x_` and HTML entities are unescaped. The answer format uses no
`*`, `_`, backtick, `<`, `>` or `&`.

### 2.3 Messages Delegatus sends through the bot token

- Telegram does not deliver a bot's own outgoing messages to its webhook, and
  Celestia stores only the updates it receives
  (`C/apps/backend/tgbot/middlewares/save_incoming_messages.py:107-111`,
  `C/apps/backend/tgbot/middlewares/builder.py:14-33`). A rich message
  Delegatus posts is therefore never in Celestia's chat history.
- When the owner replies to it, the trigger carries `reply_to_message_id`, and
  Celestia looks for that message: in history (absent), in its saved messages
  (`prepare_answer.py:2311-2331`, absent), then in the reply snapshot, which
  it drops when the author is the bot: "Telegram snapshots cannot distinguish
  AI replies from bot notices" (`prepare_answer.py:602-605`). The wire then
  has no such message, and the trigger's `reply_to` is null
  (`relay_answer_input.py:182-186`, `:321-324`).
- So a reply to the review message reaches Delegatus as the owner's text
  alone. The reference must be in that text, and it is: every copy button
  puts it there (§4.3). A bare reply such as "2" names no round and runs as a
  normal owner message.

### 2.4 State of this install (read-only, no identifiers)

- The connected bot is the Celestia clone; `telegram_bot_chats` reports
  receiving `webhook_elsewhere` (`src/lib/telegram/bot/service.ts:447-450`).
  It knows four chats: the operator's private chat and three supergroups.
- The relay is paired, with two enabled targets; the owner tier is on for one
  of them.
- 67 recorded relay answers: 25 had `is_owner: true`, 9 of those ran the
  owner tier. All came from groups; by §2.1 none can come from a private chat.
- The Delegatus project's report destination is the operator's private chat
  with the bot. Another project reports to a forum topic in a group.

### 2.5 Consequence

For this project, as configured, step 3 of §1 fails: the owner's answer in
the private chat is answered by Celestia's hosted AI and never reaches
Delegatus. Either Celestia relays the owner's private chat (§6), or reviews
go to a relay group (§7, option B). Nothing else in the flow needs Celestia.

## 3. Options considered

| | Option | Celestia change | Trade-offs |
| --- | --- | --- | --- |
| **A** | Copy-text answer through the relay; Celestia also relays the owner's own private chat with the clone | Yes, one (§6) | What the operator described. The Delegatus half works in relay groups the day it ships; the private chat starts working when Celestia ships. Every owner message in that private chat becomes an owner request here (an owner-tier agent run, or a hosted handoff when the switch is off). |
| B | Copy-text answer through the relay; this project's reviews go to a relay group topic | None | Works the day it ships. The operator replies in a group, and this project's reports move with the destination, or a second "review destination" setting is added (rejected as over-built). The group must have the install answering and replies to the bot enabled. |
| C | A separate Delegatus bot with callback buttons | None | The research lane's recommendation; the operator rejected it ("Не, не, не"). Kept for the record only. |

Recommendation: **A**, with the Delegatus half built first. It is the only
option that matches "человек просто в ответе текстом отправляет делегатусу
ответ, своему вот этому клону" in the private chat where reviews already
arrive, and the Celestia half also fills the owner-tier gap of §2.1.

## 4. Design (Delegatus half; the same for A and B)

### 4.1 Message layout

The operator's phone review approved the message and requested this refinement:
one slideshow per variant, full descriptions, and compact question paragraphs
with inline recommendations instead of answer tables. Automatic posting stays
enabled for every published round with a linked report destination, once per round.

One `sendRichMessage` with `rich_message.markdown` and the frames uploaded in
the same call (`media: [{ id, media: "attach://…" }]`, multipart; proven by
research test 6). The body follows research test 5 (slideshow with a caption
per frame: `![](tg://photo?id=v1 "Варіант 1 · …")` inside `<tg-slideshow>`)
and compact question paragraphs with recommendations marked inline, plus
`<tg-button-row>` rows. Ukrainian, the operator's interface
language. Counters are written `1/3`, never uppercased.

```
# 🧪 Прототип · {round title}
_{first line of the task}_ · #proto-{ref}

**1 · {name}**

{full description, whitespace folded to one line}

<tg-slideshow>
![](tg://photo?id=v1f1 "1 · {variant name} — {frame caption}")
![](tg://photo?id=v1f2 "1 · {variant name} — {frame caption}")
</tg-slideshow>

**2 · {name}**

{full description}

<tg-slideshow>
![](tg://photo?id=v2f1 "2 · {variant name} — {frame caption}")
</tg-slideshow>

<p><b>Питання 1/3 · {question text}{" (можна кілька)" when multiple}</b><br>a) {option label} ✅<br>b) {option label}<br>+ Інше — у коментарі</p>

…one section per question…

---
Як відповісти: натисніть кнопку, надішліть скопійований рядок клону
(відповіддю на це повідомлення) і, за бажанням, допишіть коментар з нового
рядка. Повне рев'ю — у Delegatus.

<tg-button-row align="center">
  <tg-button type="copy_text" style="success" text="{recommended line}">Скопіювати рекомендовані</tg-button>
</tg-button-row>
<tg-button-row align="center">
  <tg-button type="copy_text" text="{variant 1 line}">Варіант 1</tg-button>
  <tg-button type="copy_text" text="{variant 2 line}">Варіант 2</tg-button>
</tg-button-row>
```

Rules:

- **Slides.** One slide per frame, variants in order, the variant number
  first in every caption. Telegram allows 50 media per rich message; a round
  may hold up to 240 (`src/lib/prototypeReview/input.ts:8`). Over 50, the
  first frame of each variant comes first and the rest fill up to 50 in
  order. A frame that breaks Telegram's photo rules ("at most 10 MB",
  "width and height must not exceed 10000 in total", "ratio must be at most
  20", from the `sendPhoto` reference) is left out; frames are at most 4 MiB
  already (`input.ts:8`). Videos are left out (Deferred).
- **Buttons.** Copy-text buttons only: they need no callback, so they work
  while Celestia owns the webhook. «Скопіювати рекомендовані» appears when the
  round has questions; a round without questions has no recommendation in
  its data, so it gets only the per-variant buttons. One button per variant,
  at most 8 per row (Telegram's row limit), so 9 variants take two rows.
- **Copy text** is one line (§4.3), so the `text` attribute carries no line
  breaks. The build verifies with one live send that the attribute's text
  copies intact; if it does not, the same buttons move to `reply_markup`
  (`InlineKeyboardButton.copy_text`, accepted live in research test 2).
- **Limits.** 32 768 characters, 500 blocks (`Rich Message Limits`). A round
  is at most 9 variants and 7 questions of 6 options
  (`input.ts:8`, `:18-20`), about 80 blocks; no truncation rule is needed
  for descriptions: each is at most 300 characters and is shown in full.
  Several slideshow blocks are supported in one rich message, within the
  shared 50-attachment limit; Telegram's Rich HTML examples contain two
  adjacent `tg-slideshow` blocks. Question options use paragraph line breaks
  and normal body text, with the short "Інше" note only when allowed.

### 4.2 When and where it is posted

- **Trigger:** `publishPOST` (`src/lib/prototypeReview/http.ts:61-71`), after
  `publishPrototype` returns, starts the post without awaiting it, so the
  publication answer is not delayed. Every publication goes through this
  route: the MCP tool `publish_prototype_review` posts to it
  (`src/app/api/prototype-reviews/route.ts:5`).
- **Destination:** `effectiveReportTelegram(round.project)`
  (`src/lib/projects/settings.ts:251-254`): the chat and topic the operator
  chose for the project's reports. Null posts nothing. A chat the bot may not
  post in posts nothing and logs the refusal.
- **Once:** the send claims the bot store's send journal under the caller key
  `prototype-review` and the client request id `<reviewId>`, the same
  claim/complete pattern as `sendMedia` (`src/lib/telegram/bot/service.ts:916-1013`,
  `src/lib/telegram/bot/store.ts:651-700`). A publication replay therefore
  never posts twice, and an uncertain send is not retried.
- **Failure:** a media error (one frame Telegram refuses) resends once with
  no slideshow and the line "Кадри — у Delegatus". Any other failure leaves
  the web review as it is; the post is a convenience and the web review stays
  the source of truth.

### 4.3 The copy-text answer and its reference

**Reference.** `#proto-` followed by the first 8 hex digits of the review id
(`pr_<32 hex>`, `src/lib/prototypeReview/decision.ts:105`). It appears in the
message header and in every copy text. It identifies a round on this install
only; it is not a secret and grants nothing by itself.

**One line, at most 256 characters** (`CopyTextButton.text`: "1-256
characters"):

| Button | Copied text |
| --- | --- |
| Скопіювати рекомендовані | `Прототип «{title}» #proto-1a2b3c4d · Відповіді рекомендовані` |
| Варіант 2 (round with questions) | `Прототип «{title}» #proto-1a2b3c4d · Варіант 2 · Відповіді 1a 2b 3a` (the recommended letters, written out so the owner can edit them) |
| Варіант 2 (round without questions) | `Прототип «{title}» #proto-1a2b3c4d · Варіант 2` |

The title is cut with "…" until the line fits 256 characters; the fixed part
is at most about 90 characters.

**Grammar** (what the parser accepts):

- The reference line is the first line containing `#proto-<8 hex>`; it is
  split on `·`. The title segment is for the reader and is never parsed.
- `Варіант N` or `Варіанти N, M` (1–9, declared numbers only). Absent means
  none chosen, which a round with questions allows
  (`decision.ts:109-110`).
- `Відповіді рекомендовані` → `skip: true`, the web's "accept recommended".
- `Відповіді 1a 2bc 3+` → per question its option letters (`a` = option 0,
  the same lettering as the seat message, `decision.ts:24`); several letters
  for a multiple-choice question; `+` marks "Other", which needs a comment.
  Every question must be answered once, as on the web
  (`src/lib/prototypeReview/questions.ts:7-27`).
- Every other line of the message is the comment, trimmed.
- Normalisation before parsing: Unicode NFC, a backslash before ASCII
  punctuation removed, runs of spaces collapsed, keywords and letters matched
  case-insensitively. This absorbs the Markdown escaping a relay text may
  carry (§2.2).

### 4.4 Recognising the answer

Where: `runClaimedRequest` in `src/lib/externalRelay/runner.ts`, beside
`const owner = ownerTierFor(target, request)` (`:281`).

```
const prototype = owner ? matchPrototypeAnswer(owner.text) : null;
```

`matchPrototypeAnswer` (new, pure apart from reading tasks) returns:

| Text | Result | What the runner does |
| --- | --- | --- |
| No `#proto-` reference | null | Today's owner path, unchanged. |
| A reference matching no round, or more than one round, on this install | null | Today's owner path: a normal message. |
| A reference to a round that is not its task's waiting round (decided, superseded by a newer round, or on a task that runs elsewhere) | null | Today's owner path: a normal message, as the pinned outcome asks. The owner agent can explain with `read_prototype_review`. |
| A reference to a waiting round, text does not parse or validate | `{ round, error }` | Reply with the error and the expected line; record nothing; launch no agent. |
| A reference to a waiting round, valid answer | `{ round, input }` | Record the decision (§4.5) and reply with a confirmation. |

"Waiting" is the task's newest undecided round (`summary.waitingReviewId`,
`src/lib/prototypeReview/read.ts:9-19`), whether or not its attention card was
dismissed: dismissing hides the card and leaves the round decidable.

Only owner requests are matched. A member who pastes the same line in a group
gets today's answer path and records nothing; a request with the owner tier
switched off records nothing either. The trust anchor stays the one the owner
tier already uses (Celestia's `is_owner` plus the operator's switch), and
deciding a prototype is a smaller power than the owner tier's full agent.

How it runs inside the runner: the request keeps its run record, lease,
heartbeats, stall and lease-loss handling. At the launch point
(`runner.ts:423`) the branch becomes
`run = prototype ? runPrototypeAnswer(…) : owner ? runOwnerAgent(…) : runEphemeralAgent(…)`.
`runPrototypeAnswer` returns the same `EphemeralAgentRun` shape
(`src/lib/agent/ephemeral.ts:59-64`: `pid: null`, `done`, `cancel`), so every
existing settle path applies. The account selection at `runner.ts:325-342` is
skipped for it: nothing is spawned, so an exhausted pool must not decline a
decision. Its answer is `{ action: "reply", text, reply_to: <the trigger id> }`,
which `checkedAnswer` accepts (`protocol.ts:264`). The answer record notes
`{ owner: true, prototype: <reviewId> }` in its profile.

Confirmation text, one line:
`✅ Записав рішення «{title}»: варіант 2; відповіді 1a 2b 3a. Оркестратор отримає його.`
With no seat: `… Оркестратора зараз немає; рішення збережено в Delegatus.`
Error: `Не записав: {reason}. Формат: Прототип «…» #proto-1a2b3c4d · Варіант 2 · Відповіді 1a 2b 3a`.

### 4.5 Recording the decision through the web's path

`decidePrototype` (`src/lib/prototypeReview/decision.ts:102-156`) already
does everything the web decision does: validation, the stored decision, the
delivery text from `prototypeDecisionText` (`:16-29`, which starts
"Prototype review decision"), the client message id
`prototype-decision:<reviewId>` and the delivery state. It takes a
`NextRequest` only to hand its headers to the send and retry
(`:73-83`, through `conversationHostPOST`).

Change: its first parameter becomes the delivery context, either the web
request (today, unchanged) or `{ kind: "operator-in-process" }`. For the
latter, `send` calls `enqueueStructuredMessage` directly with the seat's
conversation and path, the same client message id and text,
`origin: { kind: "operator" }`, `policy: "steer-or-queue"`, `images: []`,
the shape `deliverReportReply` uses (`src/lib/telegram/bot/reportReplies.ts:40-45`).
`recover` is already request-free (`decision.ts:45-72`). Retries stay a web
action. So the seat receives byte-for-byte the message a web decision for
the same choices would send, and a replayed relay request lands on the same
decision (`decision.ts:120-123` returns the held decision when it is
identical, refuses a different one with 409, which the runner reports as
"already decided").

The fences of `reviewPOST` (`http.ts:87-101`) that apply to a browser
(same-origin, team actor, no capability header, no agent caller) are replaced
by the relay's own: an owner request on an enabled, owner-tier target of a
paired relay, checked by `ownerRelayAuthorized` at delivery
(`src/lib/externalRelay/ownerAuthority.ts:24-34`). The task must be local
(`runsElsewhere` false), as `reviewGET` requires for delivery (`http.ts:80`).

### 4.6 Files to change

| File | Change |
| --- | --- |
| `src/lib/prototypeReview/telegramAnswer.ts` (new) | Reference, copy-text lines, normaliser, parser, `matchPrototypeAnswer`. Pure except for reading tasks. |
| `src/lib/prototypeReview/telegramPost.ts` (new) | Renders the rich Markdown and its media list from a round; `postPrototypeReviewToTelegram(round)`. |
| `src/lib/prototypeReview/http.ts:61-71` | Start the post after a successful publication. |
| `src/lib/prototypeReview/decision.ts:31-84`, `:102-156` | Delivery context parameter; the in-process operator sender. |
| `src/lib/telegram/bot/service.ts` (beside `sendMedia`, `:916-1013`) | `sendRichMessage`: claim, multipart upload with `attach://`, topic, chat migration, complete; same refusal codes as the other sends. |
| `src/lib/telegram/bot/transport.ts:103` | Name WebP uploads `.webp` (stored frames may be WebP, `types.ts:36`). |
| `src/lib/externalRelay/prototypeAnswer.ts` (new) | `runPrototypeAnswer`: the `EphemeralAgentRun`-shaped run that calls `decidePrototype` and builds the reply. |
| `src/lib/externalRelay/runner.ts:281`, `:325-342`, `:423` | Match, skip account selection, branch at launch. |
| Tests (by path) | `src/lib/prototypeReview/telegramAnswer.test.ts`, `src/lib/prototypeReview/telegramPost.test.ts`, cases in `src/lib/prototypeReview/decision.test.ts` and `src/lib/externalRelay/runner.test.ts`. |

No wire change, no new setting, no new MCP tool, no Celestia change for the
Delegatus half.

### 4.7 Acceptance tests

All by path through `scripts/gate-slot.sh bun test <file>`, with
`LLV_STATE_DIR`, `HOME`, `XDG_CONFIG_HOME` and `TMPDIR` under the stage
scratch and `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`. Fixture strings use
short words, no identifier-shaped values.

- Parser: every copy text it generates parses back to the input it encodes
  (round trip over a fixture round with 3 variants, 3 questions, one
  multiple); edited letters, a comment on later lines, `+` with and without a
  comment, escaped punctuation, extra spaces, missing or duplicate answers,
  undeclared variants; every generated line is at most 256 characters with a
  120-character title.
- Rendering with the fake transport (`src/lib/telegram/bot/fakeTransport.ts`):
  one `sendRichMessage` per round, slide captions start with the variant
  number, each carousel contains only its variant's frames, descriptions
  remain complete, questions use compact paragraph lines without tables,
  the recommended option is marked, the buttons and their texts, the
  50-media rule, the media-error resend, a replayed publication posts once,
  no destination posts nothing.
- Runner: an owner request whose text is a copy line for a waiting round
  records exactly the decision the web would record for the same choices
  (same stored decision, same delivery text and client message id), answers
  with the confirmation, and spawns nothing; a replay of the same request
  records nothing new; a member's identical text, the owner tier off, an
  unknown reference, a decided round and a superseded round all take today's
  path; a parse error answers with the error and records nothing.
- Decision: the in-process sender sends the same text and client message id
  as the web sender for the same decision.

Live check after merge (operator's phone, in a relay group, and in the
private chat once §6 ships): a test round with 3 frames and 3 questions
arrives as one message; the slideshow swipes; each copy button copies its
line; sending it to the clone records the decision, the seat receives
«Prototype review decision», the clone confirms, and the web review shows
the same decision.

## 5. What happens to everything else

- Rounds decided on the web: the Telegram message stays as posted; a later
  copy line for that round is a normal message (§4.4).
- Owner messages without a reference: unchanged.
- Celestia's hosted path, other people's messages, the relay wire: unchanged.

## 6. The ask for Celestia (option A)

**Relay the clone owner's own private chat with the clone to the paired
install, as an owner request.** Precisely:

1. `C/apps/backend/aiinit/controllers/prepare_answer.py:206-213` and the
   dispatch at `:1981-1990`: also select relay when the clone answers through
   relay (`answer_source == RELAY` with a pairing), the delivery is the
   regular one (not inline, guest or business), and the chat is the private
   chat of the clone's owner: `request.chat_id > 0` and
   `request.chat_id == request.user_id == clone_detail.owner_id`. Every other
   private chat stays hosted.
2. `C/apps/backend/application/usecase/clones/relay_fallback.py:96-101`:
   `enqueue` accepts that request (today it raises for `chat_id >= 0`).
   `chat_enabled` has no row for a private chat
   (`C/apps/backend/infrastructure/database/repo/relay.py:469-480`): treat
   the owner's private chat as enabled whenever the clone answers through
   relay, or behind a per-clone switch defaulting to off, at Celestia's
   choice.
3. Requester block for that chat: `is_owner: true`,
   `is_anonymous_admin: false`. The tool-index branch treats
   `user_id == chat_id` as an anonymous admin
   (`C/apps/backend/application/usecase/clones/relay_requester_context.py`,
   in `build`), which is always true in a private chat and must not fire
   there; chat-member lookups must not fail on a private chat.
4. History, wire and money as for groups: the conversation is the private
   chat's stored history (private chats are already stored,
   `save_incoming_messages.py:107-111`), `respond_to` is the owner's message,
   relay v1 unchanged (the chat key is already opaque), hosted fallback and
   settlement on decline or expiry as for a group
   (`C/apps/backend/domain/entities/celestia_clone.py:33-43`).
5. A cross-check test against the Delegatus install loop, like X3 (#3505): an
   owner message in the owner's private chat yields a claimable request whose
   `requester.is_owner` is true and whose trigger text equals the message; a
   message from anyone else in their private chat with the clone is never
   enqueued.

Not asked: carrying the text of a bot message the owner replied to
(`prepare_answer.py:602-605`). The copy line carries its own reference, so the
design does not depend on it.

Consequence to accept with A: every message the owner writes in that private
chat becomes an owner request here, which with the owner tier on is a full
Delegatus agent run. That is what the owner-tier requirement asked for
("если я клону пишу от любого места, там где ему разрешено отвечать с помощью искусственного интеллекта", `docs/design/relay-owner-tier.md`), and it is the operator's call.

## 7. Decision for the operator

**Question:** the review answers must come from the private chat with the
clone, where this project's reports already go. Celestia does not relay that
chat to Delegatus today. How should this proceed?

1. **Ask Celestia for §6, and build the Delegatus half now** (recommended).
   Works in relay groups at once and in the private chat when Celestia ships.
   The seat hands §6 to the Celestia orchestrator.
2. **No Celestia change:** set this project's report destination to a group
   topic where the clone answers through this install; reviews and reports
   go there, and the owner answers by replying in that group.
3. **Build the Delegatus half only** and decide on the private chat later.
   The post and copy buttons arrive in the private chat, but answers sent
   there go to Celestia's hosted AI until 1 or 2 happens.

**Decided by the seat, 2026-10-11:** build the Delegatus half now, exactly as
§4 designs it. It needs no Celestia change and works in relay groups at once.
The choice between 1 and 2 for the private chat is the operator's and is asked
separately. This lane does not change the project's report chat and does not
touch Celestia; §6 stays as written for the seat to hand on. Until that choice
lands, a post in the private chat behaves as option 3 describes.

## Validation against the requirement

- "через [Celestia]": the answer travels the existing relay owner path; no
  second bot, no webhook change (§4.4).
- "показывать прототипы, как вот этот слайд-шоу … С описанием, Rich
  Markdown … тест 5": one rich message with `<tg-slideshow>`, numbered
  captions and per-variant descriptions (§4.1).
- "Rich Markdown первый тест, … где вопросы": headings per question and the
  option table with the recommendation marked (§4.1).
- "Скопировать короткий ответ … 3 варианта, и скопіювати відповідь … все вот
  эти рекомендуемые": «Скопіювати рекомендовані» and one copy button per
  variant (§4.1, §4.3).
- "человек просто в ответе текстом отправляет … своему вот этому клону":
  works in relay groups now; in the private chat it needs §6 (§2.1, §7).
- "чтобы из контекста было понятно, на что это ответ": the copied line names
  the round's title and reference itself, since Celestia passes no link to
  the posted message (§2.3, §4.3).
- "оно работает в штатном режиме": the decision goes through
  `decidePrototype`, and the seat gets the usual message (§4.5).
- "Или может надо проверить, правильно ли обрабатывает": checked; §2 is the
  result.

## Deferred — not currently justified

- **Editing the Telegram message after a decision** (`editMessageText` to an
  "answered" state). The web review is the source of truth and the clone's
  confirmation already says what was recorded.
- **Callback buttons and a separate Delegatus bot.** Rejected by the
  operator; copy-text buttons need no callback.
- **Videos in the slideshow.** Frames carry the review; videos stay on the
  web.
- **An "Open in Delegatus" link button.** The web address is not reachable
  from every phone (research §4 C/D); the reference already names the round.
- **A boot sweep that posts rounds missed while the Viewer was down.** A
  missed post costs nothing: the web review is unchanged.
- **Deterministic "already decided" replies.** A decided or superseded round
  is a normal message, as the pinned outcome asks.
- **A separate Telegram destination for reviews.** Reviews follow the report
  destination the operator already chose.
- **Other Delegatus questions** (stage `needs_decision`, orchestrator
  questions) through the same copy-line mechanism. They have no structured
  options today.
