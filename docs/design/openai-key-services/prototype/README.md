# What a saved OpenAI key serves: prototype

The inventory (`docs/design/openai-key-services.md`) found six Delegatus
features an OpenAI API key can serve: «Asks you», memory in chats and learned
rules (OpenAI Decisions in place of OpenRouter's Jev), dictation (recorded and
live transcription), read aloud, and Voice Delegatus (already on OpenAI when
its API backend is chosen). This prototype draws three numbered places for the
per-feature choice on the real Settings → Keys page. No product code changes.

What every variant keeps:

- the real Keys page: the product's `KeysMenuPage` with its rows, dots, notes,
  masked tails, «Add» field and optimistic save, in the desktop header menu's
  232 px panel and in the phone's menu sheet (`MobileMenuSheet`). The
  variant's own pieces sit next to the real rows through a portal;
- saving a key turns nothing on: every feature stays on its current provider
  until the operator moves it;
- no key: the OpenAI choice is hidden or disabled, and the words say why
  (variant 1 hides the switches behind one line; variants 2 and 3 show the
  current providers with OpenAI disabled and an «Add the key» action that opens
  the OpenAI field on the Keys page);
- key removed: each feature moved to OpenAI runs on its previous provider again,
  named («Soniox», «OpenRouter», «Codex V3»), and the choice is remembered, so
  saving a key brings those features back to OpenAI. The removal control itself
  is later build work (the Keys route has no delete today); the state shows its
  result;
- one line that Codex agents keep signing in with their subscription, because
  this key cannot serve them;
- the product's switch (`SettingSwitch` in `ProjectSettingRow`, amber when on
  and blocked), the agent mapping's two-choice segments, the onboarding
  dictation step's radio list and the menu's row and back-row recipes; status as
  a dot whose short note opens in the row's flow; no new colour, font, pill or
  card shape.

The invented installation reads aloud with ElevenLabs, dictates with Soniox and
talks through Codex V3, so each feature's previous provider is a non-default
one. «Switched» moves «Asks you», dictation and Voice Delegatus to OpenAI.

| Variant | Name | Where the choice lives |
|---|---|---|
| 1 | Перемикачі під рядком OpenAI · Switches under the OpenAI row | Once the key is saved, a group «Що обслуговує OpenAI» opens under the OpenAI row: one switch per feature, its line saying what serves it now («Зараз Soniox») or what OpenAI replaces («Замість Soniox»). With no key the group is one line; with the key removed only the remembered features stay, switches amber, «Без ключа працює Soniox». |
| 2 | Хто що обслуговує · Who serves what | One row «Хто що обслуговує» under «Import keys» opens a page of its own: each feature with its dot and a two-choice control (its provider or OpenAI). Without a key a notice says so with «Додати ключ» and OpenAI is disabled; a remembered feature says «З ключем повернеться OpenAI», and its amber dot's note names who serves it now. |
| 3 | У налаштуваннях кожної функції · In each feature's settings | Under the OpenAI row a list of the six features, each naming its provider now, opens that feature's own settings in place, where OpenAI is one more choice in its existing list (dictation: Faster Whisper, ChatGPT Voice, ElevenLabs Scribe, Soniox, OpenAI). Without a key the OpenAI choice is disabled with «Спершу додайте ключ OpenAI». |

Each frame prints its variant number, name and state above the surface, in the
frame's language. Telegram transcription, call notes and research tools stay
out (the inventory's «Deferred»).

## Files

- `prototype.fixture.tsx`: the whole prototype. Query string:
  `?variant=1|2|3&lang=uk|en&theme=light|dark&state=none|saved|switched|removed&page=keys|who|asks|memory|rules|dictation|read|voice`.
  Every control works: switches and choices move a feature, «Add» on the
  OpenAI row saves a typed key, «Add the key» returns to the field. The fixture
  answers `/api/keys` itself; nothing leaves the page.
- `prototype.css`: the product's `globals.css` plus this directory as a
  Tailwind source.
- `frames/`: ignored by git; the rendered frames, copied here from the run
  below. `frames/crops/` holds each desktop frame cut to the panel and caption.

## Rendering

The case `openai key services prototype` in
`src/components/conversation/conversationWindow.browser.test.tsx` bundles the
fixture with the browser drivers' evidence builder, serves `prototype.css` in
place of `globals.css`, and frames 1440 × 900 and 390 × 844 (touch), en and uk,
light and dark: variant 1 in `none`, `saved`, `switched`, `removed`; variant 2
in `entry` (the Keys page with its row), `none`, `saved`, `switched`,
`removed` and `popover` (a remembered feature's dot pressed); variant 3 in
`none`, `none-page`, `saved`, `switched` (the dictation settings), `removed`
and `removed-page`; plus each variant's `switched` at 820 px in en and uk,
light. Frames are named `variant-<n>-<width>-<lang>-<theme>-<state>.png`.

```
LLV_CONVERSATION_BROWSER_TEST=1 LLV_OPENAI_KEYS_PROTOTYPE=1 CHROME_BIN=<chrome> \
  LLV_PROTO_OUT=<dir> bun test src/components/conversation/conversationWindow.browser.test.tsx \
  -t "openai key services prototype"
```

Run it with a private HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR and
LLV_VIEWER_CONTROL_URL on a closed port. `LLV_PROTO_FRAMES=variant-2-390-uk,removed`
renders only the frames whose name contains one of the terms.

Before each capture the case checks, from text ranges: the element that defines
the state (the no-key line or notice, the first or the switched feature, the
remembered feature, the open note) is whole on the first screen; no text lies
outside the window or is cut by a clipping ancestor; no line ends in an
ellipsis; no line ends on a one-letter word; no sideways overflow; the dot's
note stays inside the surface; every control is at least 44 px under a finger
and 24 px under a pointer; a Ukrainian frame carries no Latin word outside
provider and product names; neighbouring states of one variant, and the three
variants in one state, read differently; and the page reports no errors.
