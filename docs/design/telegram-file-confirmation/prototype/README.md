# The owner's confirmation of one Telegram file send: prototype

The visual audit of the Codex-written surfaces
(`docs/audits/codex-ui-visual-audit.md` on the audit lane's branch, surface 1)
ranked this page worst:
browser-default type, every label and value on its own line, the two actions
three screens down at 390 px, and raw values (an ISO time, the chat id, a
SHA-256, detector codes) shown as stored. This prototype redraws the page
(`src/components/telegram/TelegramFileConfirmation.tsx`) on the product's
components, tokens and type, in three numbered variants of the one decision
the page exists for. No product code changes.

What every variant keeps:

- the decision and its two answers on the first screen at 390 px, before any
  scroll;
- the file that would really go, named on the first screen: the requested
  `weekly-report.json` is a link to `.codex/auth.json`, so every variant says
  «це посилання на .codex/auth.json» / "a link to .codex/auth.json" in plain
  words, and Details keeps both full paths;
- the request's state as a dot with a short popover (the word and the
  deadline live in the popover; the heading says the state in words, so colour
  is never alone). The popover opens to the left of the dot, centred on the
  card's first row («Telegram» and the dot): two lines in the phone's 44 px
  row, one line from 640 px up, so it stays inside the card and covers
  nothing. The dot's touch target reaches into the card's padding so the dot
  itself stands on the Details chevron's centre line;
- the three detector warnings as plain sentences, with no codes;
- human time: «15:10» and «ще 8 хв», never an ISO timestamp;
- one closed «Деталі» / "Details" row with no count, the phone sheet's own fold
  (`MobileSheetFold`), holding the requested and resolved paths, the hash,
  the size in bytes, the chat title, the chat id, the topic, the reply-to
  message, the caption and its format, silent delivery, the allowed folders,
  the detector codes, the request time, the request id, the expiry and the
  digest. Only paths, hashes, ids and codes are set in the code font;
- the product's button recipe (`SelfUpdateView`), its needs-you box
  (`QuestionCard`) and its permission pair (`PermissionActions`); no new
  colour, font, pill or card shape;
- a used-up confirmation («sent») opens with its outcome as the heading and
  offers no decision.

| Variant | Name | What differs |
|---|---|---|
| 1 | Питання і дві кнопки · Question and two buttons | The heading is the question («Надіслати weekly-report.json у Orbit Reports?»), its first line names the real file («Це посилання на .codex/auth.json, тож піде саме цей файл.»), the two buttons sit right under it (send is the primary), and the warnings follow in the needs-you box under «Чому запитуємо» |
| 2 | Спершу застереження, безпечний вибір першим · Warning first, safe choice first | The strongest warning is the heading («Схоже, у цьому файлі приватний ключ»), the first line names the request and the real file, the two other reasons follow as a list, and the buttons come last with «Не надсилати» as the primary and «Усе одно надіслати один раз» in the warning tone |
| 3 | Як запит дозволу · Like a permission prompt | The whole decision is the feed's permission prompt: the «Потрібні ви» box, the file as an attachment row (name, «посилання на .codex/auth.json», size and destination), the question «Дозволити агентові надіслати його?», the reasons, and the permission pair's shapes toned for a flagged send: «Дозволити раз» in the warning fill, «Відхилити» as the product's primary |

Each frame prints its variant number and name above the card, in the frame's
language.

## Files

- `prototype.fixture.tsx`: the whole prototype. Query string:
  `?variant=1|2|3&lang=uk|en&theme=light|dark&state=pending|sent` draws one
  screen at the window's size; the opened states (the fold, the popover) are
  reached by pressing the page's own controls.
- `prototype.css`: the product's `globals.css` plus this directory as a
  Tailwind source.
- `frames/`: ignored by git; the driver writes its frames elsewhere (below).

## Rendering

The case `telegram file confirmation prototype` in
`src/components/conversation/conversationWindow.browser.test.tsx` builds the
fixture with the evidence fixture builder the browser drivers use, compiles
`prototype.css` with `@tailwindcss/postcss` and serves it in place of
`globals.css`, then frames every variant at 1440 × 900 and 390 × 844 (touch),
in en and uk, light and dark, in four states: `pending`, `details` (the fold
open, the window grown to the page's height so nothing scrolls), `status`
(the popover open) and `sent`; plus the three variants at 820 px (uk and en,
light, pending). Frames and `readings.json` go to
`.artifacts/telegram-file-confirmation-prototype/`, named
`variant-<n>-<width>-<lang>-<theme>-<state>.png`.

```
LLV_CONVERSATION_BROWSER_TEST=1 LLV_TELEGRAM_FILE_PROTOTYPE=1 CHROME_BIN=<chrome> \
  bun test src/components/conversation/conversationWindow.browser.test.tsx \
  -t "telegram file confirmation prototype"
```

`LLV_PROTO_FRAMES=variant-2-390-uk,sent` renders only the frames whose name
contains one of the terms.

Before each capture the case checks, from text ranges: the page opens
unscrolled with the heading, the real file's name and, while pending, both
decision buttons whole on the first screen; no sentence of the card is said
twice; no paragraph ends on a lone short word; both decision labels read at
4.5:1 or more against their fill; the Details row carries no number; the
status popover stays at least 4 px inside the card; the status dot's centre
is within 1 px of the Details chevron's; and no empty band separates the caption
from the card; no text of the card or the caption lies outside the window
or is cut by a clipping ancestor; no line ends in an ellipsis; no sideways
overflow; the popover covers no word; every button is at least 44 px under a
finger and 24 px under a pointer; a Ukrainian frame carries no Latin word
outside names and code tokens; the three variants' cards read differently in
each language and state; and the page reports no errors.
