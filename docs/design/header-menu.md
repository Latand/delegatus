# The header's menu: variant 2's icon row, variant 3's rows

**The mix was built and is the product's header menu** (variant 2's icon row
on top, variant 3's rows below). The operator, 2026-10-06 about 23:02 Kyiv, in
the seat chat, verbatim:

> Я передумал, мне нравится вариант 2 из-за верхних иконок, активность команда оновлення, а вот дальше то, что внизу, мне нравится больше вариант 3. Наверное, как-то надо микс.

The three variants, today's inventory of the menu, their measurements and the
critique of shared memory's surfaces are the design lane's note,
`docs/design/compact-card-menu.md`, sections "The header's menu" and "Shared
memory's home", on the design lane's branch (draft PR #2543). This note says
what was built from them. Two earlier requests of the same day led there:

> …по header меню мне нужно переделать там немножко. Там тоже нужны иконки, группировка, и переделать название кнопок, потому что там, где налаштування сейчас, там вообще не налаштування.

> память включилась, не включилась… там это должно быть как-то изображено красиво… Просто надо объединить потом эти подходы… меню шапки.

## What was built

The desktop ⋯ in the rail's header, 232 px wide, for every user and with no
switch:

| Level | Entries |
|---|---|
| At rest | three icon cells, variant 2's: **Активність / Activity**, **Команда / Team**, **Оновлення / Updates**; then variant 3's rows: **Відкрити на телефоні / Open on phone** with its QR button, **Налаштування / Settings** (memory's state under its name, a count and an arrow to the right), **Довідка й навчання / Help and learning** (a count and an arrow down), **Вийти · name / Sign out · name** for a signed-in member |
| Settings, a page with a back row | language, notifications, **Спільна пам’ять / Shared memory** (its state), **Ключ OpenRouter / OpenRouter key** (Saved or Missing), **Ролі: рушій і модель / Roles: engine and model**, dictation, **Голосовий Delegatus / Voice Delegatus** (desktop only; opens the voice companion's dialog, #2519), linked installs, **Ретранслятор чатів / Chat relay**, **Анонімний пінг / Install ping** |
| Shared memory, a page | the per-project switch (`ProjectSettingRow`, amber while on and blocked), what blocks memory with its action beside it («Ввести ключ / Enter the key» opens the key's field there), three numbers (added, checked, spent of the cap) with the month, and **Докладніше / Details** with the other five counters |
| OpenRouter key, a page | what uses the key, its state, **Замінити / Replace** or the field at once when it is missing, or the line that says the environment sets it |
| Help and learning, in place | setup guide, interface walk |

Variant 3's rows for the time report, the team and the update are the three
cells, so none of them repeats as a row; the cells keep variant 2's short names
and link the same pages (the team page holds members, sessions and
invitations, as before). The back row reads «‹ Назад · Налаштування / ‹ Back ·
Settings», the critic's note that "back" be obvious. The dialog behind «Install
ping» holds the ping's notice and switch alone, under that name; shared memory
and the key left it for their rows, and the old `MemorySetting` block with
them.

Shared memory's state is a word beside a coloured dot, read from the reasons
`/api/memory/settings` reports: green «Працює · N цього місяця / Working · N
this month», grey «Вимкнено / Off», amber «Потрібен ключ / Key needed» and
«Ліміт до 1 листопада / Cap until November 1»; when a release does not serve
traffic, amber «Інший реліз / Other release». The Settings row says it short:
«пам’ять: працює / memory: working». On the overview, which has no project,
neither the row nor its state is drawn. When a later read fails, both rows
and the page say «Стан невідомий / State unknown» and the page names the
failure; the switch keeps the last setting read, and the next good read
clears it. In the menu, Details ends the month's line, so a key the route
refuses, under a month already counted and with Details open, stays within
360 px (355 px in uk).

By keyboard, a page opens with focus on its back row, back returns focus to
the row that opened the page, and Escape closes the desktop menu onto ⋯.

The phone's board menu holds the same entries: the create actions as cells, the
board's places as rows, then the three header cells, Settings and Help and
learning, and the project's switches with Archive on a **Правила проєкту /
Project rules** page. Help and learning is a page there: the sheet at rest
stands at 661 px, and opened in place it would pass today's 743 px and scroll. Its Settings page holds sound alerts and keep-awake in
place of the language, the QR and the bell, which stay in the project drawer's
header; signing out stays on the Team page. The overview's phone menu gained
Settings, which it did not have.

Every entry of today's menu is reachable, through the handler it called
before, in at most the presses variant 3 gives it (`headerMenuModel.test.ts`).

## Evidence

The existing kanban browser driver, block "the header's menu, built",
measures every state at 1440×900 and 1000×700 and the phone's at 390×844,
light and dark, en and uk, and writes
`evidence/compact-card-menu/header-menu-built.json`:

```
CHROME_BIN=<chrome> LLV_KANBAN_BROWSER_TEST=1 LLV_HEADER_MENU_OUT=<dir> \
  bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "header's menu, built"
```
