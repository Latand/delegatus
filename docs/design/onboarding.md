# First-run onboarding (#1876)

Design only. Grounded in `main` at `72154d4ae` (2026-09-19). No code, no build
was run for this document.

## 0. Originating requirement

Source: GitHub issue #1876, opened 2026-09-19 by the repository owner, body
quoted verbatim (the issue is itself an English paraphrase of the operator's
idea):

> Operator idea after watching a new user's first evening (paraphrased in
> English): the product needs an onboarding.
>
> **Scope to design**
> 1. **Engines and accounts**: detect Claude and Codex CLIs and their sign-in
>    state, offer sign-in, and state plainly what works with one engine only.
> 2. **Agent mapping**: which model and effort build, review and critique by
>    default on this install (the role presets), editable in one place, with
>    cost hints. Ties into the defaults issue for installs without Codex.
> 3. **Phone access**: an optional step for reaching the Viewer from a phone
>    (Tailscale or another private network), with the access token and the URL
>    to open.
> 4. **A short tour**: the board, tasks, pipelines and stages, the orchestrator
>    seat and how it is woken, review rounds, where to look when something
>    waits for you.
> 5. **Health check** at the end: a throw-away one-stage pipeline on the
>    cheapest model proves spawn, delivery, stage report and the seat wake on
>    this machine, and points at the failing part when it does not.
>
> **Notes** The wizard is reachable again later from settings. Text in English
> and Ukrainian. Design first (rendered at desktop and phone widths), then
> build.

Scope comment on the same issue (same date, paraphrased there): the
agent-mapping step decides per install which engine, model and reasoning effort
each role runs on; the shipped defaults stay (review on Codex) until the user
chooses; the step shows cost hints; the same design decides what a launch does
when a stage names an engine with no signed-in account, so that a stage never
starts and dies.

### The acceptance script: four problems

From the closed #1874 and #1875, what one real new user hit on their first
evening. Every screen below is judged against these in §9.

| # | Problem | What answers it here |
|---|---|---|
| P1 | Their orchestrator was never woken between stages | Tour card 4 says how a seat is woken; the health check proves the wake on this machine and names the failing part (§5) |
| P2 | Their first review ran on gpt-6-astra at xhigh with no Codex account connected | Engines step, agent mapping with cost hints, and the launch refusal (§2.1, §2.2, §4) |
| P3 | They did not know what the product can do | The tour: five cards, one screen (§2.4) |
| P4 | They wanted the Viewer on their phone | The phone step (§2.3) |

## 1. What the code says today

**First run is a derived view state, and nothing is stored.**
`src/components/ProjectRail.tsx:92` and `src/components/OverviewBoard.tsx:126`
compute `firstRun = loaded && catalogFailures === 0 && !summaries.length` and
show "No projects yet / Create a project" (#1162). No file, cookie or state row
records that an install has been set up. That predicate also misses the user
this work is for: someone who already ran `claude` in a repository has
transcripts under `~/.claude/projects`, so their very first open of the Viewer
lists projects and `firstRun` is false.

**The per-install agent mapping store already exists, with no writer.**
`src/lib/roles/store.ts` reads `state/role-presets.json`
(`RoleOverridesFile`, schema 1: `overrides[roleId].config = { engine, model,
effort }` plus an optional `promptScaffold`), validates it
(`isOverride`, `isCompatibleOverride`) and merges it over `ROLE_DEFAULTS`
(`mergeRoleDefinitions`). Every consumer already reads through it:
`resolveRole` / `resolveSpawnRole` (`registry.ts`) for a role-shaped
`spawn_agent`, `pipelineRoleLookup` (`src/lib/pipelines/roles.ts:37`) for
pipeline stages, `seededPresetsFromRoles` (`src/lib/flows/store.ts:40`) for the
review-loop presets, and `GET /api/roles`
(`src/app/api/roles/route.ts`, whose comment names "a future editing UI that
writes overrides back through saveRoleOverrides"). `saveRoleOverrides` exists
and nothing calls it. The mapping needs an editor and a write route; it needs
no new store.

**One hole in that store.** `configForParams` (`registry.ts:96`) returns fixed
configs for two builder variants, `BUILDER_FRONTEND_CONFIG` (Claude Opus high)
and `BUILDER_APPLY_FIXES_CONFIG` (Codex Terra low) from
`src/lib/roles/paramConfig.ts`, and the file comment says they "intentionally
override … a saved role override". An install with Claude only that maps
Builder to Claude still gets Codex Terra on every fix round.

**Shipped defaults** (`src/lib/roles/defaults.ts`): orchestrator and architect
on Claude Opus high; reviewer and prod-auditor on Codex gpt-6-astra xhigh;
verifier astra high; builder astra medium; cleaner terra low; deployer terra
medium. Five of eight roles and one builder variant run on Codex.

**Sign-in state is known; CLI presence is unknown.** `AccountSummary.auth`
(`src/lib/accounts/contracts.ts`) carries `state` (`authenticated |
signed_out | unknown | error`), `method`, `plan`; `limits` carries session,
weekly and per-model tier windows. Each account also has a cheap synchronous
`authPresent` (`codex.ts:330` stats `auth.json`; `claude.ts:182` reads
credential presence). Nothing checks that a `claude` or `codex` binary
resolves: `resolveBinary` (`src/lib/agent/cli.ts:55`) returns a name or path and
the first spawn finds out.

**A stage on a disconnected engine starts and dies.** `spawnPipelineAgent`
(`src/lib/pipelines/engine.ts:402`) calls `resolveProjectSpawn`; for an unbound
project with no usable account the selection answers `available` with
`accountId: null` ("the engine's own default account stands",
`projectSelection.ts:108`), and the comment at `projectSelection.ts:143` says
authentication "is decided further in, by the engine's own health pass". The
agent is spawned against a home with no credentials.

**The seat tick checks every 5 minutes and wakes at most hourly.**
`DEFAULT_SEAT_TICK_POLICY.checkIntervalMs` is 5 minutes and
`SEAT_TICK_WAKE_INTERVAL_MS` is 60 minutes (`src/lib/monitor/seatTick.ts`).
Amended after #1881: while an agent the seat spawned has settled or stalled
the bound is 5 minutes, and 15 while such agents are only running. A
project that was never woken has an empty row, and the comment in
`runSeatTickCheck` (`seatTickController.ts:1084`) confirms an empty row wakes on
the first check that finds something owed. `runSeatTickCheck(project)` is
exported and callable on demand; `GET /api/monitor/seat-tick?project=` returns
read-only diagnostics. No route triggers a check.

**Phone access is a launch-time property of the process.**
`bin/cli.mjs:711`: `--tailscale` detects Tailscale, reads its status, mints or
reuses the token (`getToken`), sets `LLV_TOKEN`, `LLV_TS_URL =
https://<dnsName>/?k=<token>` and starts `tailscale serve`. `src/proxy.ts`
gates every request on `LLV_TOKEN` once set and trades `?k=` for a 30-day
cookie. `GET /api/access` returns `{ tailnetUrl }`, and `AccessQrButton`
renders the QR client-side or, when the URL is null, the hint "Start the
viewer with Tailscale access: …" (`qr.startHint`). A running Viewer cannot turn
this on for itself; it needs a restart with the flag.

**There is no settings page.** Device and install controls live in the rail's
`RailHeaderMenu` on desktop (`rail.menuLanguage`, `rail.menuQr`,
notifications) and in the board's `MobileMenuSheet` on the phone
(`mobile2.menu.*`). Accounts open from `LimitsFooter` on desktop and from the
"Accounts & limits" menu row on the phone. "Reachable from settings" therefore
means one row in each of those two menus.

**i18n**: flat keyed dictionaries `src/lib/i18n/en.ts` and `uk.ts`, plural
objects `{ one, other }`, `useLocale().t`. New keys take the prefix
`onboarding.`.

**Prior art.** A read-only research pass on 2026-08-25 (pipeline `c1a5c520`,
found through `search_transcripts` "onboarding wizard first run") concluded "no
wizard, no first-run modal, no tour overlay" and proposed copy fixes to the
empty states; #1162 shipped those. The operator has since decided on a wizard
after watching a real first evening, so that conclusion is superseded on the
container. Its findings on the orchestrator draft (the 8 KB mandate, the MCP
preflight) are untouched by this design and stay valid follow-ups. Nothing else
relevant was found in project-scoped or unscoped search.

## 2. The flow

One dialog, five steps, one job each. No welcome screen and no finish screen:
the first step is useful at once and the last step's result is the ending.

```
1 Engines  →  2 Agents  →  3 Phone  →  4 Tour  →  5 Check
```

Shared chrome, all steps:

| Control | EN | UK |
|---|---|---|
| Dialog title | Set up Agent Log Viewer | Налаштування Agent Log Viewer |
| Step counter | Step {n} of 5 | Крок {n} з 5 |
| Primary | Continue | Далі |
| Back | Back | Назад |
| Leave | Close, finish later | Закрити, завершити пізніше |
| Leave hint (tooltip, once) | You can reopen this from the menu: Setup guide | Відкрити знову можна з меню: «Посібник із налаштування» |
| Step names | Engines · Agents · Phone · Tour · Check | Рушії · Агенти · Телефон · Огляд · Перевірка |

"Close, finish later" and Escape work on every step and write
`dismissedAt` (§6). Steps are freely navigable from the step list; none is
gated on the one before it. A step that does not apply stays in the list,
marked "skipped", so re-entry can reach it.

Offline / server unreachable, any step: the body is replaced by one line and a
retry, in `text-secondary` with a `warning` dot. EN: "The Viewer's server is
not answering. Your choices so far are saved." / "Try again". UK: "Сервер
Viewer не відповідає. Уже зроблений вибір збережено." / «Спробувати ще раз».

### 2.1 Step 1 — Engines

**One job:** show which engines this machine can run right now and get the
missing one connected, or make the user's choice to go without it explicit.

Reuses `useEngineAccounts` and the sign-in rows of `AccountsPanel`
(`ClaudeLoginRow`, the Codex device-auth row) embedded without the panel's
overlay chrome. New server fact: `cli: "found" | "missing"` per engine (§7,
slice 1), from resolving the binary and running `--version` once with a 3 s
bound.

| Element | EN | UK |
|---|---|---|
| Heading | Which engines can run here | Які рушії тут працюють |
| Lead | Agents run through the Claude Code and Codex command-line tools installed on this machine. One is enough to start. | Агенти працюють через консольні інструменти Claude Code і Codex, встановлені на цьому комп'ютері. Для початку досить одного. |
| Engine row, connected | Connected · {plan} | Підключено · {plan} |
| Engine row, signed out | Installed, signed out | Встановлено, вхід не виконано |
| Row action | Sign in | Увійти |
| Engine row, CLI missing | Not installed | Не встановлено |
| Missing detail (Claude) | Install Claude Code, then press Check again. | Встановіть Claude Code і натисніть «Перевірити ще раз». |
| Missing detail (Codex) | Install the Codex CLI, then press Check again. | Встановіть Codex CLI і натисніть «Перевірити ще раз». |
| Recheck | Check again | Перевірити ще раз |
| Auth unknown | Could not check sign-in. | Не вдалося перевірити вхід. |
| One engine only, note | With {engine} only: everything works. Roles that default to {other} need a new home, which the next step handles. | Лише з {engine}: усе працює. Ролі, що типово працюють на {other}, треба перепризначити. Це наступний крок. |
| Neither engine, note | Connect at least one engine. Until then the Viewer shows existing sessions and cannot start agents. | Підключіть хоча б один рушій. Доти Viewer показує наявні сесії й не може запускати агентів. |

States: loading (two skeleton rows, 56 px each); sign-in in progress reuses the
panel's own phases (`awaiting_browser`, `awaiting_code`, …) and copy; error
from the accounts API shows the panel's existing notice text.

Continue is always enabled. With neither engine connected the label stays
"Continue" and steps 2 and 5 show their own empty states.

Skipped when: never. This step is the ground every other step stands on.

### 2.2 Step 2 — Agents (the agent mapping)

**One job:** let this install decide which engine, model and effort each role
runs on, seeing the relative cost before the first stage runs.

| Element | EN | UK |
|---|---|---|
| Heading | Who does what | Хто що робить |
| Lead | Each role starts on the engine, model and reasoning effort set here. Pipelines, review loops and role-based spawns all read this table. You can change it later: menu → Agent mapping. | Кожна роль запускається на рушії, моделі й рівні міркування, заданих тут. Цю таблицю читають конвеєри, цикли рев'ю та запуски за роллю. Змінити можна пізніше: меню → «Призначення агентів». |
| Group: build | Build | Розробка |
| Group: review | Review | Рев'ю |
| Group: design | Design and critique | Дизайн і критика |
| Group: coordinate | Coordinate | Координація |
| Group: rare (collapsed) | Rarely used | Рідко вживані |
| Role rows | Builder · Builder, frontend · Builder, fix rounds · Reviewer · Verifier · Architect · Orchestrator · Cleaner · Prod-auditor · Deployer | Розробник · Розробник, фронтенд · Розробник, виправлення · Рев'юер · Верифікатор · Архітектор · Оркестратор · Прибиральник · Аудитор продакшену · Деплоєр |
| Column heads | Role · Engine · Model · Effort · Cost | Роль · Рушій · Модель · Зусилля · Вартість |
| Row state: shipped | default | типово |
| Row state: changed | changed · Reset | змінено · Скинути |
| Row state: blocked | {engine} is not connected | {engine} не підключено |
| Banner, one engine missing | {count} roles run on {missing}, which is not connected. A stage on one of them will be refused at launch. | {count} ролей працюють на {missing}, який не підключено. Етап на такій ролі буде відхилено під час запуску. |
| Banner action 1 | Move them to {connected} | Перенести на {connected} |
| Banner action 2 | Connect {missing} | Підключити {missing} |
| Banner action 3 | Leave as is | Залишити як є |
| After move (inline receipt) | Moved {count} roles to {connected}. Undo | Перенесено ролей: {count} → {connected}. Скасувати |
| Cost classes | light · moderate · heavy · very heavy | легка · помірна · важка · дуже важка |
| Cost headroom | {window}: {percent}% left | {window}: залишилось {percent}% |
| Cost, per-token auth | billed per token | оплата за токени |
| Cost legend | Cost is a relative weight from the model's size and the effort level. The Viewer knows no prices. | Вартість — відносна вага за розміром моделі та рівнем зусилля. Цін Viewer не знає. |
| Heavy row nudge | Very heavy for a default. Use high | Дуже важко як для типового. Поставити high |
| Save failure | Could not save the mapping: {reason}. Nothing changed. | Не вдалося зберегти призначення: {reason}. Нічого не змінено. |
| Neither engine | Connect an engine first. The table shows the shipped defaults. | Спершу підключіть рушій. У таблиці показано типові значення. |

Controls per row: engine as a two-segment control (`EngineMark` + name; a
disconnected engine's segment stays selectable and shows the blocked state, so
a user who plans to connect Codex tomorrow may still choose it); model as a
select from `ENGINE_MODELS[engine]`; effort as the existing `EffortPills`
bound to `effortScale(engine, model)`. Changing engine picks the equivalent
model (§4.3) and clamps effort through `clampEffortToScale`. Every change saves
at once (optimistic, rolled back on failure with the save-failure line); there
is no Save button and nothing is lost by closing.

"Move them to {connected}" is the user's own choice, made by pressing it. The
Viewer never moves a role by itself, which is the operator's decision on
#1875.

Skipped when: never shown as skipped. With both engines connected the banner
is absent and the step is a read-and-continue table.

### 2.3 Step 3 — Phone

**One job:** get the Viewer open on the user's phone, or let them say "not
now" in one tap.

The Viewer cannot enable remote access for itself (§1), so the step reads the
state and shows the next action for it. New server fact on `GET /api/access`:
`tailscale: "serving" | "ready" | "needs-login" | "missing"` beside the
existing `tailnetUrl` (§7, slice 3).

| State | EN | UK |
|---|---|---|
| Heading | Open it on your phone | Відкрити на телефоні |
| Lead | The Viewer stays on this machine. Your phone reaches it over a private network, and a secret key in the link keeps everyone else out. | Viewer лишається на цьому комп'ютері. Телефон підключається через приватну мережу, а секретний ключ у посиланні не пускає сторонніх. |
| Skip | Not now | Не зараз |
| serving: title | Ready. Scan with your phone's camera | Готово. Наведіть камеру телефона |
| serving: note | The phone must be signed in to the same Tailscale network. The link holds your access key: share it with nobody. | Телефон має бути в тій самій мережі Tailscale. У посиланні — ваш ключ доступу: нікому його не передавайте. |
| serving: actions | Copy link | Скопіювати посилання |
| ready: title | Tailscale is installed. Restart the Viewer with phone access | Tailscale встановлено. Перезапустіть Viewer з доступом із телефона |
| ready: command | `bunx agent-log-viewer --tailscale` | same |
| ready: note | Stop the Viewer in its terminal (Ctrl+C), run this, then reopen this step. Running agents keep working. | Зупиніть Viewer у терміналі (Ctrl+C), виконайте команду й відкрийте цей крок знову. Запущені агенти працюють далі. |
| needs-login | Tailscale is installed and signed out. Run `tailscale up`, then Check again. | Tailscale встановлено, вхід не виконано. Виконайте `tailscale up` і натисніть «Перевірити ще раз». |
| missing: title | Install Tailscale on this machine and on your phone | Встановіть Tailscale на цьому комп'ютері й на телефоні |
| missing: note | It is a free private network between your own devices. After installing, sign in on both with the same account and press Check again. | Це безплатна приватна мережа між вашими пристроями. Після встановлення увійдіть на обох під тим самим акаунтом і натисніть «Перевірити ще раз». |
| other network (disclosure) | Another private network or a VPN | Інша приватна мережа або VPN |
| other network body | Start the Viewer with `--hostname <address on that network>`. The terminal prints a link with the access key. Open that link on the phone once; it stays signed in for 30 days. | Запустіть Viewer з `--hostname <адреса в цій мережі>`. У терміналі з'явиться посилання з ключем доступу. Відкрийте його на телефоні один раз: вхід зберігається 30 днів. |
| new key (disclosure) | Lost the phone or shared the link? Restart with `--new-token`: every old link stops working. | Загубили телефон чи поділилися посиланням? Перезапустіть із `--new-token`: усі старі посилання перестануть працювати. |
| error | Could not read the access state. Try again | Не вдалося прочитати стан доступу. Спробувати ще раз |

The QR is the existing client-side renderer from `AccessQrButton` (the token
never reaches a server log or an image service), extracted into a body
component both surfaces use.

Skipped when: the wizard is itself open on a phone (`useIsMobile()` and the
request arrived through the tailnet host): the step shows one line, "You are
already here on your phone." / «Ви вже відкрили Viewer на телефоні.», marked
skipped. "Not now" marks it skipped and continues. The restart in the `ready`
state ends the page session; the wizard reopens on its own afterwards because
the marker still says unfinished (§6), landing on this step.

### 2.4 Step 4 — Tour

**One job:** five sentences-with-a-picture that say what the product does and
where to look, readable in under a minute.

One screen. Five cards in a row on desktop, a horizontal snap pager on the
phone. Each card: a 16:10 static schematic drawn with the app's own tokens
(inline SVG, no screenshots, no animation), a title, at most three lines of
body. No overlays on the live UI, no coach marks, no "next tip" sequence.

| # | Title EN / UK | Body EN | Body UK |
|---|---|---|---|
| 1 | The board / Дошка | Every agent on this machine is a card, grouped by project. A card's colour says its state: working, waiting for you, finished, stalled. | Кожен агент на цьому комп'ютері — картка, згрупована за проєктом. Колір картки показує стан: працює, чекає на вас, завершив, завис. |
| 2 | Tasks / Завдання | A task is one piece of work in your words. Agents and pipelines attach to it, so the board reads as work and its progress. | Завдання — це одна частина роботи вашими словами. До нього прикріплюються агенти й конвеєри, тож дошка показує роботу та її поступ. |
| 3 | Pipelines and stages / Конвеєри й етапи | A pipeline runs stages in order: build, review, verify. Each stage is a fresh agent in its own worktree that ends with a report: pass, fail, or needs a decision. | Конвеєр виконує етапи по черзі: розробка, рев'ю, перевірка. Кожен етап — новий агент у власному worktree, що завершує звітом: пройдено, не пройдено або потрібне рішення. |
| 4 | The orchestrator and how it wakes / Оркестратор і як він прокидається | One agent per project runs the pipelines for you. It sleeps between stages. The Viewer checks every 5 minutes: an agent the orchestrator started itself wakes it at the next check once it finishes; a finished stage or something stuck wakes it at most once an hour. You can also just message it. | Один агент на проєкт керує конвеєрами за вас. Між етапами він спить. Viewer перевіряє кожні 5 хвилин: коли агент, якого оркестратор запустив сам, завершує роботу, наступна перевірка його будить; через завершений етап або щось застрягле він прокидається щонайбільше раз на годину. Йому також можна просто написати. |
| 5 | Review rounds, and when something waits for you / Раунди рев'ю і коли щось чекає на вас | A failed review sends the work back to the builder. The rounds have a budget; when it runs out the pipeline parks and asks you. "Needs you" in the corner counts everything waiting for your answer. Press it to jump there. | Невдале рев'ю повертає роботу розробнику. Раунди мають бюджет; коли він вичерпується, конвеєр зупиняється й питає вас. «Потрібні ви» в кутку рахує все, що чекає на вашу відповідь. Натисніть, щоб перейти. |

Card 4 states the two numbers the new user never saw (5 minutes, one hour).
They are read from `DEFAULT_SEAT_TICK_POLICY` and
`SEAT_TICK_WAKE_INTERVAL_MS` at render, so the card cannot drift from the
code. Since #1881 the hour is the bound for a board where nothing the seat
spawned is moving: a child the seat launched with `spawn_agent` that settles
or stalls is due at the next check (`SEAT_TICK_SETTLED_CHILD_WAKE_INTERVAL_MS`),
and while such children only run the bound is 15 minutes. A pipeline stage is
not the seat's child (its lineage parent is the stage before it), so a
finished stage is still carried by the hourly wake as "a lane you launched". Card 5 uses the attention island's own label (`NEEDS YOU`) so the word on
the card is the word on the screen.

Controls: none beyond Back / Continue; on the phone, the pager dots and swipe.
Empty/error: none; the step is static and works offline. Skipped when: never
auto-skipped; one click passes it.

### 2.5 Step 5 — Check

**One job:** prove on this machine that an agent spawns, receives a message,
reports a stage and that a sleeping seat gets woken, and name the broken part
when one fails.

| Element | EN | UK |
|---|---|---|
| Heading | Check that it works here | Перевірити, що тут усе працює |
| Lead | Runs one tiny pipeline on {model} at low effort in a scratch folder, then wakes a test orchestrator. About two minutes, light cost. Nothing touches your projects. | Запускає один крихітний конвеєр на {model} з низьким зусиллям у тимчасовій теці, а потім будить тестового оркестратора. Близько двох хвилин, мала вартість. Ваших проєктів це не зачіпає. |
| Start | Run the check | Запустити перевірку |
| Cancel | Stop | Зупинити |
| Row 1 | An agent starts | Агент запускається |
| Row 2 | A message reaches it | Повідомлення до нього доходить |
| Row 3 | The stage reports back | Етап повертає звіт |
| Row 4 | The orchestrator is woken | Оркестратор прокидається |
| Row 5 | Your orchestrators are filed under the right project | Ваші оркестратори записані в правильному проєкті |
| Row states | waiting · running · passed · failed · skipped | очікує · виконується · пройдено · помилка · пропущено |
| All passed | Everything works on this machine. | На цьому комп'ютері все працює. |
| Finish | Open the board | Відкрити дошку |
| Failed footer | The check stopped at "{row}". Fix that, then run it again: the rows before it passed. | Перевірка зупинилась на «{row}». Виправте це й запустіть знову: попередні кроки пройшли. |
| Failed footer, nothing the user can fix | The check stopped at "{row}". The rows before it passed. | Перевірка зупинилась на «{row}». Попередні кроки пройшли. |
| Cleanup left something | Could not undo everything: {problems}. The Viewer clears what is left the next time this check opens or runs. If the next run says the same, copy this line into a bug report. | Не вдалося все прибрати: {problems}. Viewer прибере залишки, коли ця перевірка наступного разу відкриється або запуститься. Якщо після наступного запуску напис той самий, скопіюйте цей рядок у повідомлення про помилку. |
| Skip | Skip the check | Пропустити перевірку |
| No engine | Connect an engine first (step 1). | Спершу підключіть рушій (крок 1). |
| Details toggle | Show details | Показати подробиці |

Row-by-row failure copy is in §5.2. Skipped when: no engine is connected (the
row list is replaced by the no-engine line and "Open the board" stays
available). Row 5 shows `skipped` with "No orchestrator yet." / «Оркестратора
ще немає.» when the install has no seat. That is the pass a new install ends
on, so it is a captured state of its own. The note is a sentence where the
other rows carry one word: on a phone it drops to its own line under the label,
which keeps the longest row label at one line and the row at two.

The three footer lines are one sentence apart. "Fix that, then run it again"
is only written under a failure the user can act on; `DELIVERY_FAILED`,
`WAKE_NOT_OWED` and `WAKE_UNDELIVERED` say to copy the details into a bug
report, so their footer states where the check stopped and stops there.

While the check runs, no control on the screen is filled: the step's own button
is "Stop" and the footer's "Open the board" steps back to a border, so the
brightest thing during a two-minute wait is not the control that leaves. A
failed row's state word carries `text-danger` with its glyph.

"Open the board" writes `completedAt` and closes the dialog. It is enabled
whatever the check's result, including never run.

## 3. Layout

Tokens are the existing ones from `src/styles/tokens.css` and
`docs/design/viewer-design-system.md`; no new token is introduced. Tailwind
names in use today: `bg-canvas`, `bg-card`, `bg-sunken`, `bg-raised`,
`border-border`, `text-primary | secondary | muted`, `text-accent`,
`text-success | warning | danger`, engine roles `--color-claude(-soft)`,
`--color-codex(-soft)`. Light and dark come from the tokens; the dialog
declares no colour of its own, so both themes follow.

Type scale (the system's five sizes): dialog title and step heading 15 px /
700 (`--text-title`); lead and card body 13 px / 400, line-height 1.45
(`--text-body`); controls, table cells, buttons 12 px / 600 (`--text-ui`);
column heads, step counter, row state chips 11 px / 600 (`--text-label`);
cost-class chips 10 px / 600 (`--text-caption`). Commands are `font-mono`
12 px on `bg-sunken`; model names stay sans (mono rule).

Spacing rhythm: the 4 px grid, steps 4 / 8 / 12 / 16 / 24 / 32. Inside the
content region: 24 px padding, 8 px heading-to-lead, 16 px lead-to-body, 12 px
between rows or cards, 24 px before the footer. Radius: `--radius-surface`
(12 px) for the dialog, tour cards and the QR well; `--radius-control` (8 px)
for buttons, selects, segments and rows.

Layer: `Z.modal` (66) from `src/components/layers.ts`, scrim
`rgb(0 0 0 / 0.4)` over the board; the account sign-in popovers it embeds
render inline, so nothing needs a layer above it. Escape follows
`handleOverlayEscape`.

### 3.1 Desktop, 1440 and 1280

One geometry for both widths: a centred dialog 920 × 640 px (max-height
`calc(100vh - 96px)`, body scrolls, header and footer fixed). At 1440 the scrim
margin is 260 px a side; at 1280 it is 180 px. The phone layout takes
over wherever `useIsMobile()` is true (`MOBILE_LAYOUT_QUERY`), the same switch
the rest of the app uses.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Set up Agent Log Viewer                         Close, finish later   ✕  │ 52  bg-raised, border-b
├───────────────┬──────────────────────────────────────────────────────────┤
│ ● 1 Engines   │  Who does what                                 (15/700)  │
│ ◉ 2 Agents    │  Each role starts on the engine, model and…   (13/400)  │
│ ○ 3 Phone     │                                                          │
│ ○ 4 Tour      │  ┌ banner: warning-soft, 12 px pad ───────────────────┐  │
│ ○ 5 Check     │  │ 5 roles run on Codex, which is not connected. …    │  │
│               │  │ [Move them to Claude] [Connect Codex] Leave as is  │  │
│               │  └────────────────────────────────────────────────────┘  │
│  200 px       │  ROLE            ENGINE        MODEL      EFFORT   COST  │ 11/600 muted
│  bg-sunken    │  BUILD                                                   │
│  border-r     │  Builder         [Cl│Cx]   [GPT-6-Astra▾] ▮▮▯▯   heavy  │ 44 row
│               │  Builder, front  [Cl│Cx]   [Opus 5     ▾] ▮▮▮▯▯  heavy  │
│               │  …                                     content 720 px    │
├───────────────┴──────────────────────────────────────────────────────────┤
│ Step 2 of 5                                        [ Back ] [ Continue ] │ 60  bg-raised, border-t
└──────────────────────────────────────────────────────────────────────────┘
```

- Step list, 200 px, `bg-sunken`: rows 36 px, 12 px / 600. Current step:
  `text-primary` with a 2 px `accent` bar at the left edge and `accent-soft`
  fill. Done: `success` check glyph plus `text-secondary`. Skipped:
  `text-muted` with the word "skipped" at 10 px. State is carried by glyph and
  word, never by colour alone.
- Content, 720 px, `bg-card`, 24 px padding.
- Mapping table columns inside 672 px: role 176, engine 128, model 152, effort
  112, cost 104 (headroom text wraps under the class chip). Rows 44 px, 1 px
  `border-border` between rows, group labels 11 px / 600 `text-muted` with
  16 px above. A changed row shows a 6 px `accent` dot before the role name and
  "Reset" as a 12 px text button at the end of the role cell. A blocked row
  carries a `warning` glyph and the blocked text under the engine control in
  `text-warning` 11 px.
- Cost chip: `moderate` and `light` on `bg-sunken` with `text-secondary`;
  `heavy` on `warning-soft` with `text-warning`; `very heavy` on `danger-soft`
  with `text-danger`. The word is always present.
- Engines step: two engine cards side by side, 328 × auto, 16 px gap, each with
  a 3 px left border in the engine's colour role, `EngineMark` 20 px, name
  13 / 600, state line 12 px, action button right-aligned.
- Phone step: two columns, QR well 240 × 240 on `bg-sunken` at the left, copy
  and actions at the right; in non-serving states the left column holds the
  command block.
- Tour: five cards, 128 px wide × auto, 8 px gaps, in one row (672 px); picture
  128 × 80 on `bg-sunken`, title 12 / 600, body 12 / 400 `text-secondary`.
  Card 4 and 5 are the two problems' answers and get the `accent-soft` frame.
- Check: five rows 48 px, state glyph 16 px at the left (`muted` ring,
  `accent` spinner, `success` check, `danger` cross, `muted` dash), label
  13 / 400, elapsed seconds right-aligned 11 px tabular-nums. A failed row
  expands in place to its explanation block: `danger-soft` fill, 12 px padding,
  what happened (13 px), what to do (13 / 600), optional action button,
  "Show details" disclosure with the machine detail in mono on `bg-sunken`.
- Footer: primary button `accent` fill, 32 px tall, 12 / 600; Back is a
  bordered button. Focus ring everywhere: `ring-2 ring-accent/40`, the app's
  existing one.

### 3.2 Phone, 390

Full-screen sheet built on `MobileSheet`'s conventions (`Z.sheet`), safe-area
padding top and bottom. Every tappable target is at least 44 px.

```
┌────────────────────────────────────┐
│ ‹  Step 2 of 5 · Agents         ✕ │ 52  bg-raised
│ ▰▰▰▰▱▱▱▱▱▱  (2 px progress, accent)│
├────────────────────────────────────┤
│ Who does what            (15/700)  │ 16 px side padding
│ Each role starts on the…  (13/400) │
│ ┌ banner ────────────────────────┐ │
│ │ 5 roles run on Codex, which…   │ │
│ │ [ Move them to Claude        ] │ │ 44, full width, stacked
│ │ [ Connect Codex              ] │ │
│ │   Leave as is                  │ │
│ └────────────────────────────────┘ │
│ BUILD                              │
│ ┌ Builder ──────────── heavy ────┐ │ card, 12 px pad, radius 12
│ │ [ Claude │ Codex ]             │ │ 44
│ │ [ GPT-6-Astra             ▾ ]  │ │ 44
│ │ low · medium · high · xhigh    │ │ 44, EffortPills
│ │ weekly: 62% left               │ │ 11 px muted
│ └────────────────────────────────┘ │
│ …                                  │
├────────────────────────────────────┤
│ [   Back   ] [     Continue     ]  │ 64 + safe area, bg-raised, sticky
└────────────────────────────────────┘
```

- The step list collapses into the header line plus the progress bar; tapping
  the header line opens the five steps as a `MobileSheetRow` list.
- The mapping table becomes one card per role (the table's five columns cannot
  hold at 358 px of content): title row with the cost chip at the right, then
  engine, model, effort stacked, then the headroom line.
- Engines: the two cards stack. Tour: horizontal snap pager, one card per
  screen (358 × auto, picture 358 × 224), dots under it, swipe or Continue
  advances a card and then the step. Check: the rows are unchanged at full
  width; the explanation block's action button is full width.
- Phone step on a phone shows the skipped line (§2.3).

Rendered evidence owed by the build: the dialog is a new surface, so each
slice adds a case to the existing drivers and writes no new one: desktop at
1440 and 1280 through `scripts/capture-board-geometry.ts`, the phone at 390
through `src/components/mobile/issue1671Evidence.browser.test.tsx`, light and
dark, EN and UK, with measured overflow checks on the mapping table's longest
Ukrainian labels («Розробник, виправлення», «Аудитор продакшену») and the
footer buttons.

## 4. The agent-mapping model

### 4.1 Where it is stored

`state/role-presets.json`, the file `src/lib/roles/store.ts` already owns.
One file per install (it lives under the install's config directory), one
writer seam (`saveRoleOverrides`), atomic write, fail-closed read. A second
store for "onboarding choices" would be a second source of truth for the same
fact, so there is none.

Two changes to the file:

1. **Builder variants become mappable.** `RoleOverride` gains an optional
   `variants?: { frontend?: Partial<RoleConfig>; "apply-fixes"?:
   Partial<RoleConfig> }`, valid on `builder` only. `configForParams` takes the
   merged definition's variants over the two constants in `paramConfig.ts`,
   which stay as the shipped values. `DraftAgentPane` mirrors
   `configForParams` on the client and reads the same merged definition from
   `/api/roles`.
2. **Schema.** The reader accepts schema 1 and 2. The writer emits 2 only when
   a `variants` key is present, so a mapping without variants stays readable by
   an older build sharing the config directory (the case
   `loadRoleDefinitionsOrDefaults` was written for).

Write route: `PUT /api/roles` with `{ overrides }` holding `config` and
`variants` only. It merges into the stored file so an existing
`promptScaffold` override survives, validates through `isOverride` /
`isCompatibleOverride`, is guarded by `rejectCrossOrigin`, and answers the
merged catalog so the client re-renders from the server's truth. A row equal to
the shipped default is removed from the file, so "default" is a real state and
a later change to the shipped defaults reaches every role the user never
touched.

### 4.2 How role presets read it

They already do, and the design adds no reader: `loadRoleDefinitions()` merges
the file on every call, and `resolveRole`, `pipelineRoleLookup` and
`configuredReviewerFallback` go through it. Consequences to state for the
builder:

- A stage's effective role is frozen on the pipeline at creation
  (`resolvePipelineRole` runs at create time), so a mapping change affects
  pipelines created afterwards. Running lanes are untouched. The step's lead
  says "starts on", and the later-editing surface repeats it.
- `SEEDED_PRESETS` in `src/lib/flows/store.ts:59` is computed once at module
  load. The build replaces that constant's consumers with
  `seededPresetsFromRoles()` calls, or the review-loop preset list keeps
  showing the old reviewer until a restart.
- An explicit `engine` / `model` / `effort` on a stage or a spawn body still
  wins over the mapping, exactly as today. The mapping is the default for a
  role, never a veto.

"Editable later in one place": the same table component, opened alone (without
the step list) from the menu row "Agent mapping" / «Призначення агентів». The
wizard's step 2 and that surface are one component with one data source.

### 4.3 Equivalents for "Move them to {connected}"

A fixed table in `src/lib/roles/equivalents.ts`, used by the banner action and
by the engine segment control when a row's engine flips:

| Codex | Claude |
|---|---|
| gpt-6-astra, gpt-5.6-sol | opus |
| gpt-5.6-terra | sonnet |
| gpt-5.6-luna | haiku |

Claude → Codex reverses it, with `opus` and `fable` both landing on
`gpt-6-astra`. Effort keeps its tier name when the target scale has it and is
clamped by `clampEffortToScale` otherwise. The action writes ordinary override
rows, so each is visible as "changed", individually resettable, and the whole
move is undoable from its receipt. The values in this table and the shipped
defaults are the operator's call; the design fixes only the mechanism.

### 4.4 Cost hints, from what the Viewer already knows

The Viewer holds no prices and no per-conversation token totals (searched:
only test fixtures mention token counts). It does hold four facts, and the hint
is built from exactly those:

1. **The model** and its place in `ENGINE_MODELS`. A new static size class per
   catalogued model in `src/lib/roles/costHints.ts`: small (haiku, luna) = 1,
   mid (sonnet, terra) = 2, large (opus, fable, sol, astra) = 3. An
   uncatalogued model counts as large.
2. **The effort tier** on the canonical order in `efforts.ts`: low 0, medium 1,
   high 2, xhigh 3, max or ultra 4 (minimal counts as low).
3. **The signed-in account's windows** for the engine
   (`AccountSummary.limits`: session, weekly, and the per-model tier window a
   model draws on, #1796), through the same `reconcileQuotaReadings` the
   accounts panel uses.
4. **The auth method and plan** (`auth.method`, `auth.plan`).

Weight = `2 × size + effort`, shown as a word: ≤ 3 light, 4–6 moderate, 7–8
heavy, ≥ 9 very heavy. Worked against the shipped defaults: reviewer (astra
xhigh) = 9, very heavy; builder (astra medium) = 7, heavy; orchestrator (opus
high) = 8, heavy; cleaner (terra low) = 4, moderate; a haiku low health check
= 2, light. The new user's first review would have carried the app's strongest
cost mark before it ran.

Under the word, one line of headroom from fact 3: the tightest window that
model draws on, e.g. "weekly: 62% left", in `text-warning` under 30 % and
`text-danger` under 10 % (the accounts panel's own thresholds in
`capacityColor`). No connected account: the blocked-row text takes this line.
Unavailable limits: the line is omitted. With a per-token auth method (an API
key, where a subscription sign-in is absent), the line reads "billed per token" and
heavy rows keep their mark; the hint still names no amount.

The hint is an ordinal, stated as one in the legend. It is pure and
client-computable from `/api/roles` plus `useEngineAccounts`, so it needs no
route.

### 4.5 A stage whose engine has no signed-in account: decided

**Refuse at once, in words, before anything is spawned. Never fall back to
another engine.** This is the option the operator's correction on #1875 left
open and its scope comment asks this design to decide; a silent fallback was
ruled out there.

Definition: an engine is *connected* when at least one of its accounts has
`authPresent` true and, for a project with account bindings (#1279), at least
one such account is inside the project's allowed set. One function,
`engineConnection(engine, project)` in `src/lib/accounts/`, synchronous and
file-cheap, used by every seam below.

| Seam | Behaviour |
|---|---|
| `pipeline_action` start, `create_pipeline` with immediate start, the draft editor's Start | Refused with 409 `ENGINE_NOT_CONNECTED` before any stage activates. The pipeline stays a draft. |
| `create_pipeline` as a draft, the draft editor while editing | Succeeds; the answer and the stage card carry a warning per affected stage, so the author sees the resolved runtime and its state. |
| `spawn_agent` with a role, `DraftAgentPane` launch | Refused with the same code before a receipt exists. |
| A stage activating later (the account signed out mid-lane) | The stage parks before spawn with the same detail. No attempt is consumed and no fail edge fires, so the lane resumes from the same stage once the engine is connected. |
| The orchestrator seat draft | The confirm button is disabled with the same sentence under it. |

The message, the same everywhere (API `error`, stage card, toast):

- EN: "Stage "{stage}" runs on {engine}, and no {engine} account is signed in
  on this machine. Connect {engine} (menu → Accounts), or point the {role} role
  at another engine (menu → Agent mapping), or set engine and model on this
  stage."
- UK: «Етап "{stage}" працює на {engine}, а на цьому комп'ютері немає
  акаунта {engine} з виконаним входом. Підключіть {engine} (меню → Акаунти),
  або призначте ролі {role} інший рушій (меню → Призначення агентів), або
  вкажіть рушій і модель для цього етапу.»

The API answer also carries `details: { stageId, role, engine, connect:
"accounts", mapping: "agent-mapping" }`, so an orchestrator agent can relay the
choice to its operator and stop retrying. In the UI the two menu references
are buttons that open those surfaces.

`authPresent` proves a credential file, which can still be expired. That case
keeps today's path (the engine's health pass, then the park with its reason);
this rule removes the case a file check can see, which is the one the new user
hit.

## 5. The health check

### 5.1 The exact throw-away pipeline

Runs server-side from `src/lib/onboarding/healthCheck.ts`, started by `POST
/api/onboarding/health`, polled by `GET /api/onboarding/health?run=<id>`. One
run at a time per install; a second start answers the running one. Whole-run
bound 5 minutes; Stop cancels, closes the pipeline and stops the test
orchestrator.

- **Scratch repository:** `state/onboarding/viewer-health-check`, created on first use
  with `git init`, a committed `README`, no `origin` (`publishStage` already
  accepts `remote: "unavailable"`, `src/lib/pipelines/git.ts:346`). It is its
  own project (`dir-<hash>`), display name "Viewer health check", archived when
  the run ends so it leaves the rail.
- **Cheapest available model:** the smallest size class (§4.4) among connected
  engines at the lowest tier of its scale; Claude `haiku` low before Codex
  `gpt-5.6-luna` low on a tie. The lead names it before the user presses Run.
- **The pipeline:** one `run` stage, role-less, explicit engine / model /
  effort, `access: "read-only"`, no outputs, no fail edge, created and started
  through the same engine entry `create_pipeline` uses. Stage prompt: "Health
  check from the Viewer. Do nothing in the repository. Call stage_report with
  verdict pass, findings [], summary "ok"."
- **The scratch seat:** a test orchestrator on the same model and effort,
  launched in the scratch folder before the pipeline with a three-line prompt:
  "You are a test seat for the Viewer's health check. When you receive a wake,
  reply with the single word ok. Do nothing else." The pipeline is created with
  that conversation as its creator (`src`), so the lane is the seat's own.

**As built (slice 2): no seat-store record.** A seat can be ended only by a
rotation or a stillborn rollback, both under `src/lib/orchestrator/`, which is
outside this slice's fence; a designated scratch seat would outlive the run and
the real tick would keep waking it. So row 4 runs the production
`runSeatTickCheck` over the scratch project with the test orchestrator handed
in as that project's seat through the check's sources, on a tick row of the
run's own (`state/onboarding/health-runs/<run>/`), with board cards not
written. The gather, the project identity, the decision and the send are the
production ones; what stays unproven is the seat store's own lookup, which
row 5 reads for every real seat. A throw-away seat through the intent path
needs a way to end a seat, which is a finding for the orchestrator lane.

Row 1 covers both launches, each within its 60 s bound: the test
orchestrator's transcript must exist before the pipeline can name it as
creator. The scratch repository is `state/onboarding/viewer-health-check`, so
the rail names it after the folder. No project archive exists, so the project
stays in the rail with its two conversations archived off its board and its
task cards hidden.

A cleanup that could not finish keeps its run file, so the next read or start
of the check undoes the rest from what the file names; the sweep then removes
the file whatever that second attempt does, so a step that can never succeed is
tried once rather than on every read. The amber line says exactly that.

Cleanup survives a Viewer restart. As each thing comes into existence (the
scratch folder, the test orchestrator, its project, the pipeline), the run
writes it to `state/onboarding/health-runs/<run>/run.json`. A restart forgets
the run in progress, so the next read or start of the check cleans up every
run file that no live run in this process owns, from what that file names,
and then removes it. A run that ends before its pipeline exists archives the
seat off the board of the seat's project, or of the scratch folder's project
when the seat's transcript never appeared.

Row by row, what is observed (each row is a durable fact the Viewer already
records, never the agent's own claim):

| Row | Proves | Observed as | Bound |
|---|---|---|---|
| 1 An agent starts | the CLI resolves, the account launches, the host comes up | the test orchestrator's launch, then the stage attempt's, gains a conversation with a transcript | 60 s each |
| 2 A message reaches it | delivery into a live host | the stage launch receipt reaches `prompt-delivered` or later | 30 s |
| 3 The stage reports back | the agent's MCP link to the Viewer, `stage_report`, settlement | the pipeline records the accepted report and the stage settles `passed` | 120 s |
| 4 The orchestrator is woken | project identity, the tick's decision, the wake send, resume of an idle seat | one on-demand `runSeatTickCheck(scratchProject)`; its record has verdict `wake` naming the settled lane and a delivery that `wakeReached` | 60 s |
| 5 Your orchestrators are filed under the right project | the #1874 condition on the user's real seats | for every active seat, `projectSuccessionFor(seat.project, seat cwd)` owes no succession. Pure, no spawn, no wake | instant |

Row 4 uses a scratch seat so that the check never spends a real seat's hourly
wake and never writes into a real orchestrator's context. It relies on an empty
tick row waking on the first owed check (`seatTickController.ts:1084`); the
builder pins that with a test before relying on it. The on-demand check is
reachable for the scratch project only: the health route is its single caller
and refuses any other project, so the ADR's hourly bound stays unexposed.

### 5.2 What each failure looks like and what it tells the user to do

A failed row turns `danger`, expands in place, and the rows after it stay
`waiting`. Each failure has a code (in "Show details" with the machine
detail), a sentence of what happened and a sentence of what to do.

| Row | Code | What happened (EN / UK) | What to do (EN / UK) | Action |
|---|---|---|---|---|
| 1 | `CLI_MISSING` | The {engine} command was not found on this machine. / Команду {engine} не знайдено на цьому комп'ютері. | Install it, or make sure the Viewer is started from a shell where `{bin}` runs. / Встановіть її або запускайте Viewer з оболонки, де працює `{bin}`. | Go to Engines |
| 1 | `ENGINE_NOT_CONNECTED` | No {engine} account is signed in. / Немає акаунта {engine} з виконаним входом. | Sign in, then run the check again. / Увійдіть і запустіть перевірку знову. | Go to Engines |
| 1 | `ACCOUNT_EXHAUSTED` | The {engine} account has no capacity left until {time}. / Акаунт {engine} вичерпав ліміт до {time}. | Wait for the reset, or connect the other engine. / Дочекайтесь оновлення ліміту або підключіть інший рушій. | Open Accounts |
| 1 | `SPAWN_TIMEOUT` | The agent did not start within 60 seconds. / Агент не запустився за 60 секунд. | Run `{bin} --version` in a terminal. If it answers, open the agent's card to see where it stopped. If it does not, reinstall it. / Виконайте `{bin} --version` у терміналі. Якщо відповідає, відкрийте картку агента й подивіться, де він зупинився. Якщо ні — перевстановіть її. | Open the agent |
| 2 | `DELIVERY_FAILED` | The agent started, and the first message did not reach it. / Агент запустився, але перше повідомлення до нього не дійшло. | This is a Viewer fault on this machine. Copy the details into a bug report. / Це несправність Viewer на цьому комп'ютері. Скопіюйте подробиці в повідомлення про помилку. | Copy details |
| 3 | `MCP_UNREACHABLE` | The agent ran and could not reach the Viewer's tools, so it could not report. / Агент працював, але не зміг звернутися до інструментів Viewer і тому не звітував. | The agent's session has no `viewer` MCP server. Restart the Viewer; if it repeats, copy the details into a bug report. / У сесії агента немає MCP-сервера `viewer`. Перезапустіть Viewer; якщо повториться, скопіюйте подробиці в повідомлення про помилку. | Copy details |
| 3 | `REPORT_TIMEOUT` | The agent finished its turn without reporting the stage. / Агент завершив хід і не відзвітував про етап. | Open the agent to read what it said. A model that ignores the instruction is rare on this prompt; running again usually passes. / Відкрийте агента й прочитайте його відповідь. Модель рідко ігнорує цю інструкцію; повторний запуск зазвичай проходить. | Open the agent |
| 4 | `TICK_OFF` | The seat tick is turned off on this machine (`LLV_SEAT_TICK_CHECK_MINUTES=0`). / Пробудження оркестратора вимкнено на цьому комп'ютері (`LLV_SEAT_TICK_CHECK_MINUTES=0`). | Remove that setting and restart the Viewer. With it, an orchestrator sleeps until you message it. / Приберіть це налаштування й перезапустіть Viewer. З ним оркестратор спить, доки ви йому не напишете. | none |
| 4 | `WAKE_NOT_OWED` | The stage finished, and the wake check found nothing to tell the orchestrator. The finished lane and the seat are filed under different projects. / Етап завершився, але перевірка не знайшла, про що повідомити оркестратора. Завершений конвеєр і оркестратор записані в різних проєктах. | This is the fault that leaves an orchestrator waiting for ever. Copy the details into a bug report; until it is fixed, message your orchestrator after each stage. / Саме через цю несправність оркестратор чекає без кінця. Скопіюйте подробиці в повідомлення про помилку; поки її не виправлено, пишіть оркестратору після кожного етапу. | Copy details |
| 4 | `WAKE_UNDELIVERED` | The wake was sent and did not reach the orchestrator. / Пробудження надіслано, але воно не дійшло до оркестратора. | Copy the details into a bug report. / Скопіюйте подробиці в повідомлення про помилку. | Copy details |
| 5 | `SEAT_MISFILED` | The orchestrator of "{project}" is filed under another key than its pipelines, so it will not be woken. / Оркестратор проєкту «{project}» записаний під іншим ключем, ніж його конвеєри, тому його не будитимуть. | The Viewer re-files orchestrators on its next check, within 5 minutes. If this row still fails after that, copy the details into a bug report. / Viewer перезаписує оркестраторів під час наступної перевірки, протягом 5 хвилин. Якщо рядок і далі з помилкою, скопіюйте подробиці в повідомлення про помилку. | Copy details |

"Copy details" copies the code, both project keys where relevant, the tick
record's verdict and detail, and the Viewer version, passed through
`redactMonitorText`; it contains no account handle, token or home path, so it
is safe to paste into a public issue.

`SEAT_MISFILED` promises a repair. That repair is #1874's fix, on `main`
since: a key a folder has moved on from is recorded as an alias on scan, at
seat tick boot and on every tick sweep, and at designation, so the next check
re-files the seat. Row 5 reads the same judgement (`projectSuccessionFor`) for
every active seat.

## 6. Entry points

**The marker.** `state/onboarding.json`, schema 1:
`{ completedAt, dismissedAt, reason, steps: { engines, agents, phone, tour,
check: "done" | "skipped" | null }, lastHealth: { at, result, failedCode } }`.
Read and written through `GET` / `PUT /api/onboarding`. Server-side and per
install, so a second browser or the phone does not replay the wizard.

**First-run detection.** Decided once, at server start, when the marker is
absent:

- The install already holds Viewer-written state (any active or revoked seat,
  any pipeline, any task, or a `role-presets.json`, each read through its
  store's own reader): write the marker with `dismissedAt = now`, `reason:
  "existing-install"`. An upgrade never sees the wizard open by itself.
- Otherwise leave it absent. The client opens the wizard when the marker is
  absent, the page is the overview or a project root, and the URL carries no
  deep link (a conversation hash, a pipeline route, a `?k=` landing). Existing
  transcripts under `~/.claude/projects` do not count as Viewer state, which is
  what lets the wizard reach the user #1875 came from.

**Never blocking.** The dialog closes from every step by Escape, the ✕ or
"Close, finish later"; closing writes `dismissedAt` and it does not reopen by
itself again, with one exception: a marker with neither `completedAt` nor
`dismissedAt` (the page died mid-wizard, or the phone step's restart) reopens
on the step the `steps` map says is next. Nothing in the app is disabled while
the wizard is unfinished, and the launch refusal of §4.5 works identically
with or without it.

**Re-entry.** Two rows in each menu, since there is no settings page (§1):

| Surface | Row EN / UK | Opens |
|---|---|---|
| Desktop `RailHeaderMenu`, phone `MobileMenuSheet` | Setup guide / Посібник із налаштування | the wizard at step 1, all steps reachable, prior results shown |
| same | Agent mapping / Призначення агентів | the step-2 table alone |

Plus one line on the existing zero-projects panel (`overview-first-run`), under
"Create a project": "Set up engines and agents" / «Налаштувати рушії та
агентів», opening the wizard. A failed `lastHealth` adds a `warning` dot to the
"Setup guide" row, and nothing else anywhere.

## 7. Build plan, three slices

Shared gates for every slice: `bunx tsc --noEmit --incremental false` logged to
a file with its exit code, the touched tests by path with isolated state
directories, `bun run build`, the privacy gate from the merge base, `free -m`
before each heavy command with one heavy command at a time.

### Slice 1 — the mapping, the refusal, and the way in

The smallest flow that would have saved the evening: the user sees that Codex
is not connected, moves five roles to Claude in one press with the cost of
each in front of them, and a stage that still names a disconnected engine is
refused in a sentence. The dialog ships with steps 1 and 2 only ("Step {n} of
2").

Fence:

- `src/lib/roles/{types,store,registry,paramConfig}.ts`, new
  `src/lib/roles/{costHints,equivalents}.ts`, their tests
- `src/app/api/roles/route.ts` (PUT) and its test
- new `src/lib/accounts/engineConnection.ts` (connection fact and CLI probe),
  its test; the accounts route only to expose `cli` per engine
- `src/lib/pipelines/engine.ts` (start refusal, park-before-spawn),
  `src/lib/pipelines/roles.ts` (draft warnings), `src/lib/agent/spawnCommand.ts`
  (role-spawn refusal), `src/lib/mcp/bindings.ts` only for the error shape
- `src/lib/flows/store.ts` (`SEEDED_PRESETS` consumers)
- new `src/lib/onboarding/marker.ts`, `src/app/api/onboarding/route.ts`
- new `src/components/onboarding/` (`OnboardingDialog`, `EnginesStep`,
  `AgentMappingTable`, `useOnboarding`), mounted once in `Viewer.tsx`
- `src/components/AccountsPanel.tsx` only to export the sign-in rows
- `src/components/ProjectRail.tsx` (`RailHeaderMenu`),
  `src/components/mobile/MobileMenuSheet.tsx` owners, `OverviewBoard.tsx` (one
  line), `DraftAgentPane.tsx` (variants from the catalog)
- `src/lib/i18n/{en,uk}.ts` (`onboarding.*`, the refusal message)

Tests the slice owes: a state directory with one Claude account and no Codex
account, a pipeline with a bare reviewer stage: start is refused with
`ENGINE_NOT_CONNECTED` and nothing spawns; after "Move them to Claude" the same
pipeline starts on Claude Opus; an existing install's boot writes
`existing-install` and the dialog stays shut; the mapping round-trips with and
without variants under both schema versions.

### Slice 2 — the health check

Fence: new `src/lib/onboarding/healthCheck.ts` and test, new
`src/app/api/onboarding/health/route.ts` and test, `src/components/onboarding/
CheckStep.tsx`, `src/lib/i18n/{en,uk}.ts`, and read-only use of
`runSeatTickCheck`, the seat intent functions and the pipeline engine entry.
`src/lib/monitor/*` and `src/lib/orchestrator/*` are outside the fence; if the
empty-row wake or a scratch seat needs a change there, that is a finding for
the orchestrator and a separate lane. Depends on #1874's fix for row 5's
remedy. The engine tests run by path against an isolated state directory; this
slice never sweeps `src/lib/agent/` or the runtime directories.

### Slice 3 — phone and tour

Fence: `src/app/api/access/route.ts` (the `tailscale` state, a bounded
`tailscale status --json` read), `src/components/AccessQrButton.tsx` (extract
the QR body), `src/components/onboarding/{PhoneStep,TourStep}.tsx` with the
five inline SVG schematics, `src/lib/i18n/{en,uk}.ts`. `bin/cli.mjs` and
`bin/tailscale.mjs` are untouched.

## 8. Deliberately left out

Deferred — not currently justified:

- **A welcome screen and a finish screen.** Neither answers one of the four
  problems; the first step is useful at once and the check's result is the
  ending.
- **Coach marks, spotlights or a guided click-through on the live UI.** The
  2026-08-25 research argued this at length and its reasoning holds for the
  tour's content: five static cards answer P3, and an overlay needs its own
  dismissal state, focus handling and per-viewport anchoring for every surface
  it points at.
- **Turning on Tailscale from the browser, or rotating the token from the
  UI.** Remote access is set when the process starts; a route that restarts the
  Viewer or rewrites its own access key from a web request is a new attack
  surface bought for one saved terminal command.
- **Prices, token counts or a measured "this role used N % of your week".**
  The Viewer holds no price data and no per-conversation totals. A measured
  hint from `limitsHistoryStore` deltas is plausible later; it needs
  attribution of a shared window to one role, which nothing records today.
- **Per-project mappings.** The decision on #1876 is per install. A stage's
  explicit engine / model / effort already covers the one-off case.
- **Editing prompt scaffolds in the mapping table.** The store supports it; it
  serves none of the four problems.
- **Automatic fallback to the other engine, in any form**, including "only
  during onboarding". Ruled out by the operator on #1875.
- **Creating the user's first project or first orchestrator inside the
  wizard.** The zero-projects panel already does the first; an auto-created
  seat is a paid session nobody asked for. The tour's card 4 points at the
  Orchestrator button.
- **The orchestrator draft's own gaps** (the 8 KB mandate shown raw, the
  missing `viewer` MCP preflight) from the 2026-08-25 research. Real, separate,
  and the health check's `MCP_UNREACHABLE` row will now surface the second one
  with a name.
- **Re-running the check on a schedule, or a standing health badge.** One
  `warning` dot on a menu row after a failed run is the whole footprint.
- **Analytics on wizard completion.** The project collects none.

## 9. The draft judged against the four problems

| Screen or mechanism | P1 wake | P2 wrong engine, xhigh | P3 what it does | P4 phone | Verdict |
|---|---|---|---|---|---|
| Engines | | shows Codex as not connected before anything runs | | | keeps its place |
| Agents + cost hints | | the move action and the "very heavy" mark on astra xhigh | | | keeps its place |
| Launch refusal (§4.5) | | ends "starts and dies" for users who never open the wizard | | | keeps its place; the only part that protects a user who skips everything |
| Phone | | | | the whole step | keeps its place, optional |
| Tour | card 4 states the 5-minute and one-hour numbers | | cards 1–5 | | keeps its place at five cards |
| Check rows 1–3 | | row 1 names a disconnected engine | | | keeps its place |
| Check rows 4–5 | proves the wake and detects the #1874 condition | | | | keeps its place |
| Marker + re-entry | | | | | required by the issue; two menu rows |

Cut while drafting, for serving none of the four: a welcome screen, a finish
screen with a recap, quick-fill presets beyond the single "Move them to
{connected}" action ("lower cost", "Codex only"), a sixth tour card on
worktrees, a "test wake to my real orchestrator" button (it spends the real
seat's hourly wake and adds a turn to its context), and a language picker
inside the dialog (the rail menu already has one and the dialog follows it).

Honest limits of this design against the script. P1 was a bug, and the wizard
cannot prevent a bug; what it adds is that the same failure is caught in two
minutes with a named code, where the new user lost two hours. The heaviest
piece of machinery here is the scratch seat in row 4: if the builder finds the
seat intent path cannot host a throw-away seat without changes under
`src/lib/orchestrator/`, row 4 falls back to the tick decision alone (verdict
`no-seat` naming the settled lane proves the identity half without a send),
and that reduction should be reported, since it leaves the send unproven.
