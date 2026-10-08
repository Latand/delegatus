Originating requirement. Operator, 2026-10-09 about 02:15 Kyiv, seat chat, after the first live session with the voice Delegatus on the stage copy (verbatim, Russian):

> Так, во-первых, было бы неплохо какое-то... какие-то звуки, когда подключаемся и отключаемся от голосового делегатаса. Во-вторых, он меня всё время убеждал, что он не может отправить... у него нет никаких инструментов, он как будто бы не знает, что у него есть вот эти инструменты, которые мы ему зашили. Также, когда он всё-таки начал их использовать, то он их почему-то... он, например, не смог отправить и говорит, что, типа, «не було надіслано». Ну, типа, «не було озвучено» или что-то в этом роде, типа, хотя говорит... хотя я всё равно ему сказал, типа, «отсылай». Если ты можешь найти этот разговор, у него, то найди, почитай, что там было. Кстати говоря, вот тоже разговор: иногда, когда он говорит голосом, то его голос прерывается, так, обрывается, и потом продолжается, и это неудобно. Может быть, там какой-то есть баг. Также, э-э. Хотелось бы, чтобы была возможность нажать кнопочку и посмотреть весь транскрипт покрутить, который был выше, что... что мы говорили. Вот, чтобы можно было скопировать что-то, чтобы он, например, мог что-то сделать, и там эти все вызовы смотреть. Вот. И, соответственно, чтобы он знал больше о себе, что у него больше... что у него есть функции, что его зовут делегатус, дай ему. Мужской голос, какой-то промпт, который похожий на тот, который в мандате стоит. По его этому. Характеру.

# Voice Delegatus: fixes from the first live session

Stacked on PR #2542 (branch `pipeline/build-the-voice-delegatus-the-floating-c-e6e96858`, head `60a3e9ccb`).
Every file:line below is on that head. The stage copy served `f391ef2c6`, two
commits earlier; those two commits change placement, styles and the browser
driver only, and every voice module cited here (`sessionConfig.ts`,
`tools.ts`, `liveSession.ts`, `admission.ts`, `liveGate.ts`, `gate.ts`,
`media.ts`, `liveAdapter.ts`, `deliveryPaths.ts`) is identical in both.

Everything approved for #2542 stays: `docs/design/voice-companion-research.md`,
the look, placement, bubbles, collapse, send-at-once with the model's own
confirmation exception, talk-first. This note changes only what items 1 to 6
need.

## Summary

| Item | Cause found in the session | Fix | Failing-first test |
| --- | --- | --- | --- |
| 1 Identity and tools | The Live instructions name no tool and call it "a conversation partner" (`sessionConfig.ts:11-15`); the provider's prompting guide says the Live model decides what to hand off from a `Backend tools:` list in its instructions, which this one lacks. | New instructions (text below) with the mandate's character, the project, masculine self-reference, the operator's language, and a `Backend tools:` section generated from `COMPANION_TOOL_REGISTRY`. | The mint body sent to the provider carries the generated section, line for line from the registry, and the mandate's character sentences. |
| 2 Male voice | `voice: "marin"` (`sessionConfig.ts:27`), the provider's default; the companion spoke of itself in feminine forms («Зрозуміла»). | `meridian`, labelled Masculine, Natural, North American in the provider's GPT-Live voice table (observed 2026-10-08 23:25 UTC). | The mint body carries `audio.output.voice: "meridian"`. |
| 3 Delivery | All four sends were refused by the server's pattern gate with `not_requested`: it admits a send only when a sentence contains the word «оркестратор» or "orchestrator" and opens with a listed English or Ukrainian verb (`gate.ts:123-124`, `liveGate.ts:42-53`). The operator spoke Russian and said «отошли», «отправь ему», «передай». The tool then said only "This request was refused" (`tools.ts:40`), so the voice invented a reason («ти відкликав прохання»). | In a live session the backend model's judgment decides a send, and the pattern readings leave that decision; structural refusals stay. Every refusal and failure carries its own plain sentence, and a refusal from the orchestrator route becomes `failed` with its reason. | A Russian "отправь ему" turn through the local fake provider reaches the orchestrator send path once; a missing seat says "no designated orchestrator". |
| 4 Speech breaks | The browser mutes the companion's own audio whenever the microphone reads above 0.035 RMS and unmutes on the next quiet frame (`media.ts:95-101,111-115`, `liveAdapter.ts:196-205`). Residual echo, a breath or a cough cuts the voice until the next pause. The provider's output timeline for the same lines runs on with no hole longer than 1.4 s. | Remove the microphone-level barge-in; GPT-Live handles interruption itself. An explicit interrupt unmutes only after 1,500 ms of quiet. | A realistic speech envelope with 0.04 RMS residual echo never mutes the audio and never cuts the line (today: muted 10.3 s of 14 s, 14 switches). |
| 5 Sounds | None exist. | Two short oscillator cues in the browser, played by the adapter once per connect and once per disconnect. | One connect cue and one disconnect cue per session across every way a session ends; none for a start that never connected. |
| 6 Transcript | The record keeps the last 512 events (`admission.ts:42`), almost all of them per-fragment transcript snapshots, so the first 112 s of a 6-minute session are gone; tool calls keep their name only. | Requirements below; the look comes as numbered variants in a later stage. | The transcript record holds every tool call with its arguments and result, and a session longer than the event ring is whole. |

Verdict: pass. Item 2 was observed on the provider's own documentation; nothing
in this note waits on the operator. Item 6's look is the operator's pick in the
variants stage.

## Step one: evidence from the stage

### Where the stage records a voice session

The stage installation keeps its state under `$HOME/.local/share/delegatus-stage/state`
(`LLV_STATE_DIR`) and runs as the user unit `delegatus-stage.service` serving
`f391ef2c6` on a loopback port. Everything below was read from copies or with
read-only tools; nothing on the stage was started, stopped, requested or
written. Neither the OpenAI key (`config/delegatus/openai-api-key`) nor the
`ACCESS` file was opened; the launcher's environment files were read through a
filter that replaced every token value, and no key or token was printed.

| Record | Where | What it held for this session |
| --- | --- | --- |
| Voice sessions | `state/voice-companion.json` (`CompanionStorage`, `storage.ts:134`) | One session. Its operator inputs (25 segments, all kept: the bound is 64), its last 512 events of 701 (`seq` 190 to 701), no proposal, its usage (364 s) and its charge. |
| Transcript items | inside that file: `inputs` and `transcript.snapshot` events | Operator segments whole; companion segments only from 112 s on. |
| Tool calls | `tool.called`, `tool.result`, `delegation.tool.*` events | Name, call id, a 240-character speech summary or a code. No arguments, no result body. |
| Provider events | not stored | Only their effects: transcript snapshots, the closing usage. |
| Delivery attempts and answers | `proposals` in the session; the orchestrator's conversation | No proposal was stored and nothing was sent (each refusal came before a proposal was written). |
| Orchestrator | `state/orchestrator-seats.json` | Absent: the stage has no designated orchestrator for any project. Nothing from the voice reached any conversation. |
| Server logs | the unit's journal | No line since the unit started on 2026-10-08 14:41 UTC. The voice modules log nothing by design (`provider.ts:18`, "Never logs upstream errors"). |
| Browser events | the page only | Local playback, microphone level and barge-in events are never sent to the server. |

The session was started in another of the operator's projects, one of the
other repositories on this machine; the stage's board shows that project, and
the stage has no orchestrator seat for it.

### The session

One voice session in the window: minted 2026-10-08 23:07:14 UTC, closed by the
operator at +368 s (23:13:22 UTC), `reason: "operator"`, 364 s of voice, locale
`uk`. The operator spoke Russian throughout; the companion answered in
Ukrainian, in feminine forms.

Turns that matter, verbatim from the record (`[t]` is the provider's audio
timeline in seconds; identities, handles and paths stripped):

```text
[  ? ] Operator: А что ты умеешь делать, расскажи
[  ? ] Operator: Какие функции у тебя есть / Какие у тебя функции есть
           (the companion's answers to these two are lost: events 1-189 were evicted)
[  ? ] Operator: У тебя, у тебя, получается, нету никаких инструментов, вызовов
[ 70.4] Delegatus: Можу працювати з тим, що є в цьому середовищі, відповідати на питання та пояснювати.
           Якщо знадобиться щось на кшталт зовнішніх викликів, я скажу, чи можу це зробити, і що саме вмію тут.
[ 95.4] Operator: Окей, то есть ты не видишь сейчас никаких инструментов, я понял. А также мне неудобно,
           что я не могу всю, весь разговор раскрыть, посмотреть. Я бы хотел посмотреть транскрипт весь
[109.4] Delegatus: Зараз дізна́юся, чи є такий варіант. Розумію, було б зручно бачити весь транскрипт,
           але в цьому чаті я не можу відкрити чи отримати його повністю. Я можу спиратись лише на ті
           повідомлення, які мені передали.
[153.4] Operator: А еще при, прерывается у меня... только когда ты озвучиваешь, прерывается так как
           знаешь как, знаешь я не знаю описать... Наверное какой-то баг есть
[183.6] Operator: Также еще проблема, что когда ты еще не договорила ,то, а сообщение уже пропало
[193.4] Delegatus: Уточню і це.
        TOOL conversation_messages -> failed PROJECT_REFUSED
[197.2] Delegatus: Схоже, повідомлення зникає ще до того, як закінчується озвучення. Я не можу перевірити
           причину чи передати це команді без прямого прохання; якщо хочеш, можу надіслати їм опис обох
           проблем: і про переривання озвучення, і про зникнення повідомлення.
[231.6] Operator: Передай только... попроси ничего не делать, я хочу, я хочу сам продолжить
        TOOL request_orchestrator_delegation
             instruction: «Пока ничего не делайте с проблемами: прерывается озвучивание, а сообщение
             пропадает до его завершения. Оператор хочет сам продолжить.»
             -> refused, code not_requested; speech "This request was refused. Nothing was sent."
[238.8] Delegatus: Зрозуміла, повідомлю про це без прохання щось змінювати. Нічого не надсилаю, бо ти
           попросив поки нічого з цим не робити.
[259.8] Operator: Не, всё-таки отошли, да, отошли
        TOOL request_orchestrator_delegation -> refused, not_requested
[267.8] Delegatus: Нічого не надіслано, бо попереднє прохання ти відкликав, а теперішнє «всё-таки отошли»
           не уточнює, що саме надсилати. Якщо ти хочеш, щоб я
[277.4] Operator: А, ну, да, отправь ему все проблемы, которые я озвучил, скажи ему, чтобы он ничего
           не делал, что я сам продолжу, оператор повернется к тебе, сам продолжит
        TOOL request_orchestrator_delegation -> refused, not_requested
[293.2] Delegatus: Нічого не надіслано: раніше ти попросив поки нічого з цим не робити й продовжити
           самостійно, тож зараз запит на відправку не прийнято.
[296.0] Operator: Я тебе разрешаю
[304.8] Delegatus: Чую, ти дозволяєш, але сам дозвіл без чіткого запиту від тебе я не можу сприймати як
           прохання надіслати.
[313.2] Operator: В смысле можешь, как раз ты у тебя так это сделано
        TOOL request_orchestrator_delegation -> refused, not_requested
[323.4] Delegatus: Не надіслано: спершу ти відкликав прохання
[326.0] Operator: Передай какой-то параметр, может ты какой-то параметр не передаешь
[327.6] Delegatus: Зрозуміла, зараз оформлю це як чіткий запит і передам.
        (the operator ended the call)
```

The backend model raised a send four times, each time on a turn where the
operator had asked for one, with a faithful instruction. The server refused all
four. The reasons the voice gave («ти відкликав прохання», «не уточнює, що саме
надсилати») appear nowhere in what the server returned: the tool said only
"This request was refused. Nothing was sent." The operator's «не було
надіслано» is this.

### What the stage did not record

Each gap below is a requirement in item 6.

1. **The first 112 seconds.** `admission.ts:42` keeps the last 512 events, and
   every transcript fragment is its own `transcript.snapshot` event (493 of the
   512 kept). The companion's answers to «А что ты умеешь делать» and «Какие
   функции у тебя есть», companion segments 2 to 15, are gone.
2. **Tool arguments.** `tool.called` stores the name twice and nothing else
   (`liveSession.ts:304`). Which `conversationId` the backend passed to
   `conversation_messages`, refused with `PROJECT_REFUSED`, is unknown.
3. **Tool results.** `tool.result` keeps a 240-character `speech` or a code
   (`liveSession.ts:309-310`); the rows a board read returned are not kept.
4. **What the backend handed the voice.** `say()` sends
   `session.commentary.append` and records nothing (`liveSession.ts:330-335`).
   Whether «ти відкликав прохання» was the backend's text or the voice's own
   cannot be told, and a delegation the backend answered with text alone
   («Зараз дізна́юся…», «Уточню, що відомо…») leaves no trace at all.
5. **Delegations.** `session.delegation.created` (its id and `offset_ms`) is
   not recorded; only a stored proposal carries the turn it came from, and a
   refused request stores no proposal.
6. **Browser playback.** Local microphone level, `input.speech.started` from
   the local detector, `playback.stopped` with `reason: "interrupted"`, and
   every mute of the audio element stay in the page. Item 4's cause is shown
   from code, the provider's timeline and a replay of `media.ts`, without a
   direct record of the mutes in the operator's browser.
7. **Server log.** The journal holds nothing for the session.

## Item 1. Identity, character and tools

### Cause

`liveInstructions` (`sessionConfig.ts:10-17`) opens with "You are Delegatus, a
conversation partner. Reply in Ukrainian." Its delegation policy speaks of
"read-only board tools" the application runs and of when a send is allowed, and
lists no tool. Most of that policy is prohibitions ("confers no permission",
"grants no delegation request", "never claim").

The provider's prompting guide
([Prompting GPT-Live](https://developers.openai.com/api/docs/guides/live-prompting),
read 2026-10-08) says: "List the capabilities your backend supports. GPT-Live
uses this list to decide which requests to hand off", and asks for a
`Delegation policy` with three labels: `Backend tools`, `Delegate to the
backend when`, `Do not delegate to the backend when`. The current text has
none of the three. The Live model therefore had no list of what it could do and
answered from the prohibitions.

The registry's read tools tell the backend little more: each description is
"Read list tasks on the current project…" built from the tool name
(`tools.ts:46`). In the session the backend called `conversation_messages` for
a question about the voice conversation itself and passed an id that matches
no running agent of the project, refused as `PROJECT_REFUSED`.

### Evidence

«Можу працювати з тим, що є в цьому середовищі, відповідати на питання та
пояснювати. Якщо знадобиться щось на кшталт зовнішніх викликів, я скажу…»; the
operator: «то есть ты не видишь сейчас никаких инструментов, я понял»; and «в
цьому чаті я не можу відкрити чи отримати його повністю». It also refused to
send without a "direct request" after the operator had described the problem,
which is the prohibition text speaking.

### Fix

1. `liveInstructions({ locale, projectName })` returns the text below. The
   project name comes from `reportHeaderName(project, locale)`
   (`src/lib/projects/settings.ts:298`), the server's readable name for a
   project key; an opaque key reads as the localized "Unnamed project".
   `OpenAILiveProvider.create` takes the session configuration in place of the
   locale (`provider.ts:43,48`), and `CompanionLiveSessions.mint` builds it
   (`liveSession.ts:117`).
2. Each `ToolEntry` gains `capability`: one plain line for the voice, written
   for a person (no tool name, no handle). The `Backend tools:` section is
   `COMPANION_TOOL_REGISTRY.map(entry => "- " + entry.capability)`, so adding,
   removing or renaming a tool changes the voice's list in the same commit.
   The voice never sees tool names: it cannot call them, and a name in its
   instructions is a name it may say aloud.
3. The read tools get real backend descriptions in the same entries, for
   example `conversation_messages`: "The latest messages of one running agent
   in this project. conversationId is a handle returned by agent_activity."
4. The character sentences are the mandate's, verbatim. They stay in the voice
   module; a test asserts that `ORCHESTRATOR_SYSTEM_PROMPT`
   (`src/lib/orchestrator/prompt.ts:398`) contains the same two sentences, so
   a change of the mandate's character fails the voice's test until both
   agree. The orchestrator prompt file is not edited.
5. The backend instructions (`BACKEND_INSTRUCTIONS`, `sessionConfig.ts:18`)
   gain three sentences, the rest standing: "The operator speaks Ukrainian,
   Russian or English, and may name the orchestrator as him, it or them, or not
   at all after the voice offered to send something. A request whose content
   asks the orchestrator to do nothing yet is still a request to send it. When
   a tool says a request was not sent, return its reason in its own words and
   add none."

The instructions, as sent (`${…}` filled at mint):

```text
You are Delegatus, the voice of this Delegatus installation. You talk with its operator about the project in view, ${projectName}. Delegatus runs the operator's AI coding agents: a board of tasks, pipelines of agent stages, and the project's orchestrator, the agent that owns the project's work. You talk things through, answer questions about the work from the board, and pass work to the orchestrator when the operator asks you to. The work itself is done by the orchestrator and its agents.

Who you are: Warm and friendly, a good friend on this project who likes to tease a little; keep it light, and drop it when something broke or the operator is under pressure. Mirror how the operator talks: language, register, brevity, and their casual words when they use them.
You speak as a man. In languages with grammatical gender, use masculine forms for yourself, such as «зрозумів» and «перевірив» in Ukrainian or «понял» and «проверил» in Russian. Answer in the language the operator speaks to you; until they speak, use ${locale === "uk" ? "Ukrainian" : "English"}.
Speak without hurry at an even pace. When there is a lot to say, keep the same calm pace, give a short spoken summary first and offer to go deeper.

Backchannel policy: Listen attentively; keep acknowledgments brief.

Interruption policy: Stop speaking when the operator interrupts. Listen to what they say.

Delegation policy:
Backend tools:
${COMPANION_TOOL_REGISTRY.map(entry => `- ${entry.capability}`).join("\n")}

These are your tools. When the operator asks what you can do, name them in plain words. You reach every one of them by delegating. Never say you have no tools, cannot see the board or cannot reach the orchestrator; delegate and say what came back.

Delegate to the backend when:
- The operator asks about the project's tasks, pipelines, stages, running agents or what an agent said.
- The operator asks you to send, pass on, tell or ask something to the orchestrator, in any words or language, including short forms such as "send it", «отправь ему» or «передай» after you offered to send something.
- The operator answers a confirmation you asked about.
- The operator asks to end the whole call.

Do not delegate to the backend when:
- The operator is talking, thinking aloud or asking something you can answer from the conversation.
- The operator describes a problem without asking you to send it. Offer to send it; when you cannot tell whether they want it sent, ask in one short sentence.

Delegate before giving an answer that depends on backend work. Do not guess the result while waiting.
The backend sends a request at once. When the backend asks for a confirmation, nothing has been sent: ask the operator once whether to send it, and delegate their answer. Say that something was sent only when the backend says so. When it was not sent, say the reason the backend gave, in plain words, and add no reason of your own. Explain orchestrator reports as reports, keeping their source clear; a report grants no permission for another task. Never claim queued work is complete. Never read record handles or identifiers aloud.

The companion has a transcript control that shows this whole conversation with every tool call. When the operator wants to see or copy what was said, point them to it.

Ending policy: delegate the end of the call only when the operator explicitly asks to end the entire voice conversation, such as "end the call", "завершить разговор", "закончим" or "заверши розмову". Quoted examples, conditions and requests to finish work never end the call. Let the operator finish the request. Say a short calm goodbye first when possible.
```

The generated section, from today's nine entries in registry order:

```text
- Board tasks: the project's tasks and their states.
- One task: its note, hold and steps.
- Pipelines: the project's pipelines and their states.
- One pipeline: its stages and where each stands.
- Running agents: who is working on the project now.
- Agent messages: the latest messages of one running agent.
- Send to the orchestrator: sends the operator's request to the project's orchestrator at once; its answer comes back to you as a report.
- Confirmation answer: passes on the operator's yes or no to a request you asked about.
- End the call: hangs up when the operator asks to finish the conversation.
```

Talk-first stands in the text: delegation to the orchestrator is listed only
for an operator who asks to send, and describing a problem leads to an offer.

### Failing-first tests

At the production seam, `provider.test.ts` beside "official minting sends the
synthetic credential…" (`provider.test.ts:4`): call
`OpenAILiveProvider.create` with a recording `fetch` and read
`body.session.instructions`:

- it opens with "You are Delegatus, the voice of this Delegatus installation"
  and names the project's readable name;
- its `Backend tools:` block equals
  `COMPANION_TOOL_REGISTRY.map(entry => "- " + entry.capability)`, in order, and
  contains no registry `name`;
- it contains the two character sentences, and `ORCHESTRATOR_SYSTEM_PROMPT`
  contains the same two;
- it contains "masculine forms" and no fixed "Reply in Ukrainian";
- `backendRequest([]).tools` names equal the registry's names (kept from
  `sessionConfig.test.ts:31`).

Red today: no `Backend tools:` block, no project, "a conversation partner".
`sessionConfig.test.ts:28-48` keeps its pacing and confirmation assertions,
reworded where the sentence moved.

## Item 2. A male voice

Observed 2026-10-08 23:25 UTC (2026-10-09 Kyiv), on the provider's own pages:

- [GPT-Live conversations, "Voice options"](https://developers.openai.com/api/docs/guides/live-conversations#voice-options):
  `audio.output.voice` takes a built-in name or an authorized custom voice;
  the default is `marin`; the voice cannot change during a session. Its table
  of the additional GPT-Live voices labels each voice's presentation. Masculine:
  `ripple` (English, Australian, natural), `vesper` (English, British,
  natural), `stone` (English, Irish, natural), `meridian` (English, North
  American, natural), `tempo` (Portuguese, Brazilian, natural), `beacon`
  (English, Filipino, generated), `cinder` (English, Southern U.S.,
  generated).
- [openai-python `types/live/built_in_voice.py`](https://github.com/openai/openai-python/blob/main/src/openai/types/live/built_in_voice.py),
  generated from the API specification (last change 2026-09-10, "Add Live
  API"): the 22 built-in names, the twelve above plus `alloy`, `ash`,
  `ballad`, `cedar`, `coral`, `echo`, `marin`, `sage`, `shimmer`, `verse`.
- The model page ([gpt-live-1](https://developers.openai.com/api/docs/models/gpt-live-1))
  lists no voices. The older realtime voices (`cedar` among them) carry no
  presentation label on any provider page read; a third-party page listing
  other names (`juniper`, `breeze`, `vale`, `ember`) disagrees with both
  official sources and was set aside.

**Pick: `meridian`.** It is labelled masculine and natural, and North American
is the most neutral regional influence for a voice that speaks Ukrainian and
Russian. The provider says "Test the voice with the languages and pronunciation
your application needs"; that listening happens on the stage, since no check
may make a paid call. If its Ukrainian sounds wrong there, the change is one
constant to another masculine voice from the table (`vesper` or `stone`), with
no selector.

Fix: `sessionConfig.ts:27` `voice: "meridian"`, named as one exported constant
`LIVE_VOICE`. Test: the recorded mint body carries
`audio.output.voice: "meridian"` (red today: `"marin"`).

## Item 3. A delegation the operator asked to send is sent

### Cause

`CompanionAdmission.propose` refuses a live-model request before it looks for
a recipient (`admission.ts:207`, then `:211`) through `liveProposalRefusal`
(`liveGate.ts:32-54`). For a finished source turn it calls
`explicitDelegationRequest` (`liveGate.ts:42`), which refuses any utterance
without the word "orchestrator" or «оркестратор» (`gate.ts:123-124`,
`no_orchestrator`), then requires the sentence to open with one of a list of
English or Ukrainian verbs addressed to the orchestrator (`gate.ts:93-107`).
`no_orchestrator` is not among the declined reasons, the two-turn look back
finds no such word either, and the result is `not_requested`
(`liveGate.ts:53`).

Replaying the session's four turns through the real functions (a scratch test
importing `liveGate.ts` and `gate.ts` from this branch):

```text
turn 13 «Передай только... попроси ничего не делать, я хочу, я хочу сам продолжить»  -> not_requested (no_orchestrator)
turn 14 «Не, всё-таки отошли, да, отошли»                                          -> not_requested (no_orchestrator)
turn 15 «А, ну, да, отправь ему все проблемы, которые я озвучил, скажи ему, …»       -> not_requested (no_orchestrator)
turn 17 «В смысле можешь, как раз ты у тебя так это сделано»                       -> not_requested (no_orchestrator)
«Передай оркестратору все проблемы.»  -> admitted ("передай" is also a Ukrainian verb)
«Отправь оркестратору все проблемы.»  -> not_imperative
```

So the gate refuses a Russian send unless its verb happens to be spelled the
same in Ukrainian and the sentence names the orchestrator, and it refuses
every send that calls the orchestrator "him" after the companion itself
offered to send. The model read the operator right four times out of four;
the pattern read them wrong four times out of four.

Second, the refusal reached the voice without its reason. `NOT_SENT`
(`tools.ts:33-36`) names six codes; `not_requested` and every other code fall
to "This request was refused. Nothing was sent." (`tools.ts:40`). The voice
filled the gap with a reason of its own.

Third, behind the gate the stage has no orchestrator seat
(`orchestrator-seats.json` absent), so with the gate passed the same request
would have been refused as `no_orchestrator` (`admission.ts:211`), whose
sentence exists.

Fourth, found while tracing delivery: `companionDeliveryPaths.send` throws
`DELIVERY_UNCONFIRMED` for any non-success answer of the orchestrator route
(`deliveryPaths.ts:28`), including a definite refusal from relay admission with
its `code` (`src/app/api/orchestrator/message/route.ts:42`). The send is then
stored as `unknown`, and every events poll sends it again with the same key
(`liveSession.ts:431-432`): every 500 ms during the call and every 2 s after
it while the page waits for the delivery, with the reason never said.

### Fix

1. **In a live session the model's judgment decides a send.** This is the
   operator's standing rule for Delegatus (2026-10-06): pattern detectors are
   hints for an agent's judgment, never a hard refusal, and nobody grows the
   pattern list to chase misses. `liveProposalRefusal` keeps only its
   structural refusals: `invalid_instruction` and `already_requested` (the same
   words as a request raised in an earlier turn). The source-turn reading, the
   look back, the "don't send" veto and the retraction reading at proposal time
   leave it. Whether the operator asked is the backend model's judgment, made
   with the whole masked transcript, its instructions (item 1) and the
   `confirmation_reason` it sets when unsure.
2. **The spoken yes to a confirmation follows the same rule.** In a live
   session a `resolve_orchestrator_confirmation` "send" stands on the model's
   reading (`tools.ts:69`, `admission.ts:188,256`); only the structural check
   stays, that the answer comes in a later turn than the request. Today «Я тебе
   разрешаю», the operator's own words in this session, would be refused as
   `not_confirmed`.
3. **Withdrawal of a waiting confirmation is unchanged.** It moves into its own
   function used only by `CompanionAdmission.input` (`admission.ts:118`), with
   the reading it has today: it can only cancel a confirmation the model itself
   asked for, which sends nothing.
4. **Every outcome has its sentence.** `spoken` (`tools.ts:37-40`) reads from
   one table typed `Record<DelegationCode, string>` over the union of codes the
   admission returns, so a code without a sentence fails to compile and the
   generic fallback is deleted. The tool result carries `reason` (the sentence)
   and `speech`: "Nothing was sent. Tell the operator this reason in plain
   words and add none: <reason>". For `no_orchestrator`: "This project has no
   designated orchestrator, so nothing was sent." For a route refusal:
   "The orchestrator's conversation refused the message (<code in words>), so
   nothing was sent."
5. **A refusal from the orchestrator route is a failure with its reason.**
   `send` returns `{ status: "failed", code }` for a 4xx answer that carries a
   `code`; it keeps throwing (stored as `unknown`, recovered with the same key)
   only for a lost answer or a 5xx. The proposal stores `failureCode`, and the
   card and the speech name it. The poll stops re-sending a failed request.

What still guards talk-first: the instructions (item 1), the backend's own
judgment with its confirmation exception, one send per request
(`sameRequest`, `already_requested`), and the card that shows every request
sent with its delivery state. The original #2519 defect, the composer voice
delegating on almost every turn, was traced to its prompts, which send every
request, correction and question to the backing agent
(`voice-companion-research.md`, §1). The record of this session shows the
companion's model raising a send only when the operator asked for one.

### Failing-first tests

Through the local fake provider and `CompanionLiveSessions`
(`liveSession.test.ts`, its fake `LiveProvider` and fake delivery paths with a
recipient):

1. Input transcript deltas for turns 13 to 15 of this session, verbatim, a
   `session.delegation.created` after turn 15, and a fake backend that answers
   with one `request_orchestrator_delegation` carrying the session's own
   instruction. Expect: the delivery path's `send` called exactly once with
   that instruction, the tool result `status: "sent"`, and the commentary sent
   to Live containing "Sent". Red today: refused `not_requested`, `send` never
   called.
2. The same with `recipient()` returning null: the commentary contains "no
   designated orchestrator", and no proposal is sent.
3. A delivery path whose route answers 409 with `code`: the request settles
   `failed` with that code, `send` is called once across three event polls,
   and the commentary names the reason. Red today: `unknown` and a send per
   poll.
4. A confirmation the fake backend asked for, then the turn «Я тебе разрешаю»
   and a `resolve_orchestrator_confirmation` "send": delivered once. Red
   today: `not_confirmed`.
5. Guard, green before and after: a waiting confirmation followed by «Забудь.»
   is withdrawn and nothing is sent.
6. The table test: every member of the code union has a sentence, and no tool
   result anywhere says "This request was refused".

Live-session tests in `liveSession.test.ts`, `admission.test.ts` and
`tools.test.ts` whose requests name the orchestrator keep passing; any that
assert a live refusal for a request's wording are rewritten to the structural
rules. The prototype gate (`admitDelegationProposal`, `companion.test.ts`) and
the end-call reader (`tools.test.ts:107`) keep their tests.

## Item 4. Speech that cuts out and resumes

### Cause

`BrowserCompanionMedia.sample` (`media.ts:91-109`) runs every animation frame.
Any microphone frame at or above 0.035 RMS marks input on for 200 ms
(`media.ts:95-97`). The adapter treats input on as a barge-in
(`liveAdapter.ts:204`): it stops the playing line as `interrupted`, marks every
line not yet played as skipped, and calls `media.interrupt()`
(`liveAdapter.ts:196-201`), which mutes the audio element (`media.ts:111-115`).
The element is unmuted on the first frame where the companion's received audio
is below 0.008 RMS and input has been off for 200 ms (`media.ts:101`), which is
the next pause between phrases.

GPT-Live is full duplex and handles interruptions itself ("respond to
interruptions", in the prompting guide); the provider's WebRTC example plays the received track straight into an audio
element ([WebRTC guide](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live)),
and its server-controls guide reserves client muting for an application that
must block audio. The microphone already runs with `echoCancellation`; what it
leaves of the companion's own voice, a breath, a cough or a keyboard is enough
to cross 0.035.

### Evidence

- The operator: «прерывается… только когда ты озвучиваешь» and «когда ты еще
  не договорила, а сообщение уже пропало». The second is the same mechanism
  seen on screen: the cut line stops showing bubbles
  (`VoiceCompanion.tsx:559-567`, a cut line shows what played), and the audio
  that resumes is bound to no shown line (`liveAdapter.ts:172` finds no
  unclaimed line, since the barge-in marked every shown line as played).
- The provider kept generating. Over the kept companion lines its output
  timeline advanced 318 times: 296 steps of 200 or 400 ms, 17 of 600 ms,
  3 of 800 ms, and two of 1.2 and 1.4 s, both at sentence ends
  («…отримати його повністю.» +1.4 s «Я можу…»). A step is one fragment's end
  minus the previous one's, so a 600 to 800 ms step is a long word or a short
  pause, and the record cannot tell which; nowhere did the provider's speech
  stop for seconds and resume.
- Nothing shows the provider hearing the companion as the operator: no
  operator segment repeats the companion's words. Two operator segments overlap companion
  speech, and both are the operator's own words: «Я тебе разрешаю» spoken over
  a reply (which ran on 3 s after it; the provider did not yield to it), and
  «Передай какой-то параметр…» as the companion began to answer. The only
  code that silences received audio in the middle of a reply is the page's
  own, above.
- Replaying the real `media.ts` (a scratch test with the existing test's
  fakes, 60 frames a second, 14 s of speech: 240 ms words at 0.10 RMS, 70 ms
  dips, a 600 ms pause every six words and 1,200 ms every fourteen, and a
  microphone that carries a residue of the companion's own voice):

  | Residual echo during words | Audio muted | Mute and unmute switches |
  | --- | --- | --- |
  | 0.02 RMS | 0.0 s of 14 s | 0 |
  | 0.04 RMS | 10.3 s of 14 s | 14 |
  | 0.06 RMS | 10.4 s of 14 s | 14 |

  Above the threshold the operator hears the first word after each pause and
  then silence until the next pause: speech that cuts out and comes back.
  The echo level in the operator's room was not recorded (gap 6 above).
- The behaviour is pinned by tests today: `liveAdapter.test.ts:51-53`
  ("barge-in cuts playback") and `media.test.ts:118-122`, where one quiet
  frame after an interrupt unmutes.

### Fix

1. The microphone level no longer interrupts playback. `liveAdapter.ts:202-206`
   drops `yieldPlayback()` and the `input.speech.started` it emits for the
   local level; the operator's speech reaches the record and the lane through
   the provider's own input transcript, as it does now. `media.ts:94-97` stops
   sampling the microphone for this purpose.
2. GPT-Live's own interruption handling decides when the companion yields to
   the operator. A stretch of played audio that ends early simply ends; the
   line shows what played.
3. `interrupt()` stays for the explicit `interrupt` command of the contract.
   It unmutes only after 1,500 ms of quiet output (`DISPLAY_PAUSE_MS`, the
   transcript's own segment boundary), longer than any paced pause in the
   record, so an explicit interrupt never brings back the rest of a sentence.

No sound path, codec or playback buffer changes: WebRTC carries the audio, and
the application schedules no chunks.

The trade-off: once the page stops muting, yielding to the operator is the
provider's behaviour alone. In this record it let one reply run on for 3 s
over «Я тебе разрешаю». The instructions keep "Stop speaking when the operator
interrupts", the provider's own template line. If, after this fix, the
operator still hears hitches of under a second inside a phrase, item 6's
per-fragment timing (below) shows whether they are the provider's 600 to
800 ms steps; that is a question for the stage listen, with no change planned
for it now.

### Failing-first tests

1. `media.test.ts`, at the real `BrowserCompanionMedia` with its existing
   fakes: the 14-second envelope above with 0.04 RMS on the microphone during
   words. Expect `audio.muted` never true, no `input` callback that interrupts,
   and `speaking: false` only within the pauses. Red today: 10.3 s muted.
2. `liveAdapter.test.ts`: `callbacks.input(true)` while a line plays emits no
   `playback.stopped` with `interrupted` and calls `media.interrupt()` zero
   times; the line ends `played`. Replaces `liveAdapter.test.ts:51-53`.
3. `media.test.ts`: after an explicit `interrupt()`, 600 ms of quiet output
   leaves the element muted; 1,500 ms unmutes it. Replaces
   `media.test.ts:118-122`.
4. Playback continuity at realistic timing: the adapter fed the record's own
   companion timeline (gaps of 600 to 1,400 ms inside one line) keeps the line
   as one played line (`CONTINUE_MS`, `liveAdapter.ts:15`).

## Item 5. A sound on connect and on disconnect

### Design

- **Where.** `OfficialVoiceCompanionAdapter` owns the session's lifetime, so it
  plays both cues. Connect: once, after `media.answer()` and the first events
  read succeed (`liveAdapter.ts:94-96`). Disconnect: once, through one latch
  reached from `close()` (the operator's hang-up, a project change, an
  unmount), from the server's `session.closed` (`liveAdapter.ts:136`: the model
  ended it, the cap, a provider error, a lost transport) and from `lost()`
  (`liveAdapter.ts:214`). The latch is armed only by the connect cue, so a
  start that never connected plays neither.
- **What.** A new browser module `src/lib/voiceCompanion/cues.ts` with
  `connectCue()` and `disconnectCue()`. Each is two sine tones from an
  `OscillatorNode` through one `GainNode`: connect 660 Hz then 990 Hz,
  disconnect 990 Hz then 660 Hz, 70 ms each with 20 ms between, an 8 ms
  attack, an exponential release, peak gain 0.05; under 200 ms in all. No
  file, no fetch, no `decodeAudioData`.
- **Context.** The module owns one `AudioContext`, created on the Talk tap and
  closed on `dispose()`; the media's context closes with the media, before a
  disconnect cue would play. `resume()` is called before each cue; the tap is
  the user activation the browser needs.
- **Injection.** `AdapterOptions.cues` replaces the module in tests.

### Failing-first tests

`liveAdapter.test.ts` with its fake media and fetch and a counting `cues`:

- a successful start plays one connect cue;
- each end plays one disconnect cue, whatever came first: `close()`; a server
  `session.closed` with `reason: "tool"`, `"cap"`, `"error"` or
  `"transport"`; `lost()`; and `close()` after `session.closed` still totals
  one;
- a start refused before a session (`NO_KEY`, `MICROPHONE_REFUSED`) plays
  none;
- two sessions in a row play two and two.

`cues.test.ts` with a fake `AudioContext`: two oscillators per cue, last stop
under 250 ms after the first start, every gain value at most 0.05, and no
network or decode call.

## Item 6. The whole conversation on demand: requirements

The look is the operator's pick among numbered variants in the next stage. One
control on the companion opens it; no other new chrome.

### What the record holds

One ordered record per voice session, oldest first. Each entry has its kind,
its time from session start, and its text or data, cleaned by the admission's
cleaner (credentials) and `withoutLocalPaths` before it is stored or served:

| Entry | Holds |
| --- | --- |
| Operator utterance | the display segment's final text, start and end on the provider's timeline |
| Companion reply | the segment's final text, start and end, and each fragment's start and end on the provider's timeline (two numbers per fragment), so a pause inside a reply can be read back; the line as generated by the provider |
| Delegation | Live's delegation (time on the timeline) and the operator turn it came from |
| Tool call | name, arguments as the backend sent them (pretty JSON, up to 4,000 characters), result as returned to the backend (up to 8,000), `done` or `failed`, the refusal or failure code and its sentence |
| Hand-off to the voice | each text sent with `session.commentary.append`, tied to its delegation |
| Request to the orchestrator | the instruction sent, its delivery state as it changes, the failure reason |
| Orchestrator answer | the report's status and cleaned text |
| Session start and end | the time, the end reason, the voice seconds |

Text in the view is selectable and copyable as plain text, each entry with its
speaker or kind, in the operator's interface language for the labels.

### Where each piece comes from

All of it is assembled on the server, the only place that sees tool arguments
and results:

- utterances and replies: `LiveTranscript` segments from
  `session.input_transcript.delta` and `session.output_transcript.delta`
  (`liveSession.ts:208-210`), one entry per segment, updated in place while it
  grows, never one entry per fragment;
- delegations: `session.delegation.created` (`liveSession.ts:211-219`);
- tool calls and results: the backend loop (`liveSession.ts:270-289`) and
  `runCompanionTool`'s return (`liveSession.ts:306-311`);
- hand-offs: `say()` (`liveSession.ts:330-335`);
- delivery and answers: the admission's existing events and
  `orchestrator.answer`.

Browser playback (played or cut) is the page's own knowledge; the view may show
it for the session on screen, and the record does not depend on it.

### How long it is kept

- While a session is open, the record is whole however long the session runs;
  the bounds are per entry (above) and 4 MB per session. The 512-event replay
  ring, the 40-line reducer history (`reducer.ts:112`) and `LiveTranscript`'s
  64-segment window (`liveTranscript.ts:62`) stay as they are for what they
  serve, and none of them bounds the record.
- After a session ends, the view still shows it until the next Talk.
- On disk the record is one private file per session under the state
  directory (`voice-companion/transcripts/<session>.jsonl`, mode 600), written
  as entries settle. It stays out of `voice-companion.json`, which is rewritten
  whole on every change. Closed sessions' files are kept for 30 days and at
  most the 50 most recent, pruned when a new session is minted.
- The record is read by a GET on the existing session route for that session
  id, behind the same operator check; no route writes it.

### Tests the build stage owes

- A session longer than the event ring: 800 transcript fragments plus tool
  calls through the fake provider; the record holds every segment from the
  first, each once.
- A tool call's record entry holds its arguments and its result, cleaned (a
  synthetic credential in an argument comes back masked).
- A closed session's record is served after `session.closed`; one older than
  30 days is pruned at the next mint.
- Rendered evidence for the transcript view through the kanban driver's
  "floating voice companion" describe, at 1440 and 1000, en and uk, light and
  dark.

## Validation against the operator's words

| The operator said | Where it lands |
| --- | --- |
| «звуки, когда подключаемся и отключаемся» | Item 5: one cue each way, every way a session ends. |
| «убеждал, что он не может отправить… у него нет никаких инструментов» | Item 1: a generated tool list in the voice's instructions and an explicit line against saying it has none. |
| «не смог отправить и говорит… «не було надіслано»… хотя я… сказал «отсылай»» | Item 3: the pattern gate that refused four real requests leaves the send decision; every refusal says its real reason. |
| «найди, почитай, что там было» | Step one above. |
| «его голос прерывается… и потом продолжается… какой-то баг» | Item 4: the page's own microphone-level mute is removed. |
| «нажать кнопочку и посмотреть весь транскрипт… скопировать… эти все вызовы смотреть» | Item 6: the record and its requirements; the look comes as variants. |
| «чтобы он знал… что его зовут делегатус… промпт… как в мандате… характеру» | Item 1: name, purpose, project, the mandate's character verbatim. |
| «Мужской голос» | Item 2: `meridian`, and masculine self-reference in item 1. |

## Notes

- **The stage cannot show item 3 until it has an orchestrator.** It has no
  designated orchestrator for any project, and the session ran in a project
  other than Delegatus. After this lane, a send on the stage answers "This
  project has no designated orchestrator" until a seat is designated there.
  The companion probably showed that note in its lane during the session
  (`VoiceCompanion.tsx:592`); the page's state is not recorded.
- **Disk churn.** Every transcript fragment rewrites `voice-companion.json`
  whole, with an fsync (`storage.ts:160-168`): about 700 rewrites of a file
  growing to 219 KB in six minutes. Item 6's one-entry-per-segment record and
  per-session file remove most of it; the replay ring can coalesce snapshots of
  one segment the same way.
- **Pacing.** The two pauses of 1.2 and 1.4 s fall at sentence ends, where the
  instructions ask for "short pauses". Item 4's fix leaves the provider's
  pacing as it is.
- **Two readers of the same class remain**: the end-call reader
  (`liveEndRefusal`, which already covers Russian) and the withdrawal of a
  waiting confirmation. Neither misread anything in this session.
- **"Зараз дізна́юся" with no tool call.** Twice the voice said it would find
  out («Зараз дізна́юся…», «Уточню, що відомо…») and no tool call followed.
  Whether it delegated at all, and what came back, cannot be read back (gaps 4
  and 5). Item 6 records both.

## Deferred — not currently justified

- A voice selector or a per-language voice. The spec rules out a selector; one
  masculine voice covers the request.
- Tuning the local echo threshold or adding echo detection. The local barge-in
  is removed; the provider already handles interruption.
- Sending browser playback events to the server. It would have shown item 4's
  mutes directly; with the mechanism removed, nothing needs watching.
- Earlier sessions' transcripts in the interface. They stay on disk for
  investigation; the operator asked for the conversation in progress.
- A copy-all button or an export file. Selection copies; the variants stage
  can show whether anything more is wanted.
- Extending the pattern grammar to Russian. It is the growing-list approach the
  operator rejected on 2026-10-06, and it still could not read «отправь ему».
- Moving the character sentences into a shared constant in the orchestrator
  prompt file. A test that compares them is enough, and leaves the mandate
  file alone.

## Fences kept

Product source, the stage and its state were not changed; nothing was
committed. No paid provider call was made: the voice list was read from
documentation, and both replays (`liveGate.ts`, `media.ts`) ran under a scratch
directory with an isolated state directory and a closed control port. The seat
wake and tick code, seat rotation, provider-limit recovery, the update drain
and `usage.ts` pricing are untouched by every fix above.
