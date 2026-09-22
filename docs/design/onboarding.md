# First-run onboarding (#1876)

Design only. Grounded in `main` at `72154d4ae` (2026-09-19). No code, no build
was run for this document.

Slice-3 revision, 2026-09-22, grounded in `main` at `7fb7345e5`: §0 adds
the slice-3 requirement, §1.1 what the code says about it, §2.1 the
add-account rows, §2.3, §2.4 and §2.6 the phone, tour and voice steps, §3
and §7 their layout and build plan. Slices 1 and 2 have shipped; their
sections stay as the record and are unchanged.

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

### Slice 3 requirement (2026-09-22)

Operator request, 2026-09-22, paraphrased in English from the pinned
specification of this slice (the operator's own words stay off public
surfaces):

> The setup guide grows from three steps (Engines, Agents, Check) to the full
> flow.
>
> 1. **Phone step = one button.** Today phone access is a launch flag and the
>    QR button only says "start the viewer with Tailscale access". After this
>    slice the step shows the state (Tailscale installed / logged in / serve on
>    / not installed) and ONE primary button turns access on from the running
>    Viewer: it persists the choice for future starts, enables `tailscale
>    serve` and the token, restarts or re-binds the Viewer process itself if
>    that is what it takes, and comes back with the URL and the QR. No terminal
>    command is ever shown as the happy path. A missing or logged-out Tailscale
>    gets one plain sentence and one link, nothing else. Fast: one press and a
>    wait with a visible state.
> 2. **Tour step = one screen, short, in the product's own words.** It must say
>    what Agent Log Viewer IS: an orchestrator of coding agents for development
>    work, where everything revolves around tasks on the kanban board, not a
>    session viewer. It explains the orchestrator seat (it runs everything, and
>    how it is woken), what a pipeline is (stages, review rounds, where things
>    wait for you), and offers the first action: create the first orchestrator
>    seat in a project (Opus high or medium), preferably an existing project
>    the Viewer already lists. README keeps the detailed guide; the tour links
>    to it. Five cards at most, inline SVG schematics where they help.
> 3. **Transcription step:** choose the backend (local | chatgpt | elevenlabs |
>    soniox), paste the key for elevenlabs/soniox, one "Check" that calls the
>    real `/api/transcribe/token` path and reports the answer in a sentence;
>    writes `transcribe-backend`, `soniox-api-key`, `elevenlabs-api-key` under
>    the config directory through a server route (keys never logged, never
>    echoed back, mode 600). Reachable later from the same menus as the Setup
>    guide.
> 4. **Several accounts per engine:** the Engines step gets an "Add account"
>    action per engine that reuses AccountsPanel's existing add/sign-in rows;
>    every connected account is listed with its state.
> 5. Everything in en and uk, rendered and checked at desktop 1440 and 1280 and
>    phone 390; the step list, "Step n of N", Back/Continue/Close semantics and
>    the marker keep working; existing tests stay green.

Source for items 3 and 4: GitHub issue #2004, opened 2026-09-22, body quoted
verbatim:

> The onboarding dialog (`src/components/onboarding/OnboardingDialog.tsx`) has
> three steps: engines, agent mapping, check. Two things a new install needs
> are missing from it and are only reachable by hand-editing files under the
> config directory.
>
> **1. Transcription backend and key.** Dictation depends on
> `transcribe-backend` (`local | chatgpt | elevenlabs | soniox`) and, for the
> live backends, on a key file (`soniox-api-key`, `elevenlabs-api-key`) or the
> matching env var. On a fresh server the backend defaults to a non-live one,
> so the composer's live dictation answers `409` from `/api/transcribe/token`
> and the batch fallback answers `502` when the ChatGPT path has no signed-in
> Codex account. Nothing in the UI says why; the user sees "cannot transcribe".
> Wanted: an onboarding step (also reachable from settings) that shows the
> current backend, lets the user pick one, paste the key for a live backend,
> and runs a one-shot check (the existing `/api/transcribe/backend` GET already
> reports availability per backend). The key is written to the same file the
> server reads today; the step never displays it back.
>
> **2. Several accounts per engine.** Onboarding detects one Claude and one
> Codex sign-in. The accounts panel already supports several accounts per
> engine with limits and a project binding, but onboarding does not lead
> there: a user who wants a second account to log in and be selectable for a
> project has to find the panel on their own. Wanted: the engines step offers
> "add another account" for each engine, using the same sign-in rows the
> accounts panel uses, and shows which account a project will use.
>
> Notes: the stage host case above was fixed by hand: the key file copied and
> `transcribe-backend` set to `soniox`; both files are read on every request,
> so no restart was needed. Design doc: `docs/design/onboarding.md`. Keep the
> "nothing is gated" rule: every step is skippable and reachable later.

The one-button phone step reverses a decision §8 of the first revision made
("Turning on Tailscale from the browser … is a new attack surface bought for
one saved terminal command"). The operator's requirement demands it, so §2.3
designs it and §8 records what of the old caution survives (the token is
never rotated from the browser, the public internet is never used).

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
this on for itself today; §1.1 records why it can after slice 3 (nothing in
the gate is read at boot) and §2.3 designs the button.

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

### 1.1 Addendum for slice 3 (2026-09-22, at `7fb7345e5`)

Slices 1 and 2 shipped; the facts above stay as the record. What the code
says about the four new pieces:

**The access gate reads its environment on every request, nothing at boot.**
`src/proxy.ts:50` reads `process.env.LLV_TOKEN` inside `proxy()`;
`src/app/api/access/route.ts:22` reads `LLV_TS_URL` inside `GET`;
`src/lib/sameOrigin.ts:34` reads `LLV_TS_HOST` inside `allowedHostNames()`.
A value written to `process.env` inside the serving Viewer therefore changes
the gate from the next request on, with no restart. Once `LLV_TOKEN` is set,
every connection must carry the `llv_auth` cookie, loopback included
(`proxy.ts:63-67`, "loopback is shared by every OS account"); the cookie is
set for 30 days by `redirectWithCookie` (`proxy.ts:18-33`,
`COOKIE_MAX_AGE_SECONDS` at line 8), `secure` only when the request arrived
over https.

**The Viewer cannot restart itself without taking the launcher down.**
`bin/cli.mjs` supervises the server as a child; the child's `exit` handler
(`cli.mjs:390-416`) stops the serve child and the runtime host and then calls
`process.exit`. A Viewer that exits to "restart with the flag" ends the
launcher, and nothing starts it again. So the slice re-binds the running
process and never restarts it (§2.3).

**Every Tailscale primitive already exists in `bin/tailscale.mjs`, in
foreground form.** `detectTailscale` (line 149) resolves the binary from
`PATH` or the macOS app bundle; `readStatus` (197) runs `tailscale status
--json`, treats `NeedsLogin` and `Stopped` as "sign in" (207) and an empty
`Self.DNSName` as "enable MagicDNS"; `serve` (220) spawns a foreground
`tailscale serve <port>` (221) that lives as a child and recognises the
missing operator right by a stderr pattern (237); the token lives at
`<config>/agent-log-viewer/token` (273), 32 hex characters (94), written with
mode 600 (283) by `getToken` (287). `src/lib/telegram/sessionStore.ts:5`
already imports a `bin/*.mjs` module from `src/`, and `tsconfig.json` has
`allowJs`, so a Viewer route can call these functions rather than copy them.

**The launcher reads no config file.** Every option comes from `argv`
(`parseArgs`, `cli.mjs:173-215`); `--tailscale` flips `options.tailscale`
(203); `prepareRuntime` (707-735) detects, reads status and mints the token;
`buildChildEnv` (338-347) hands `LLV_TOKEN`, `LLV_TS_HOST` and `LLV_TS_URL` to
the Viewer child; the serve child starts after the server (880-882) and is
stopped with it (395-401). "Persist the choice for future starts" therefore
needs one file the launcher reads before `parseArgs` decides.

**Tailscale's background mode is what "persist" needs on the tailnet side.**
On this machine (`tailscale version` 1.102.4, read 2026-09-22) `tailscale
serve --help` lists `--bg` ("run the command as a background process") and
`serve status [--json]`; `tailscale serve status --json` answers `{ TCP: {
"443": { HTTPS: true } }, Web: { "<dns>:443": { Handlers: { "/": { Proxy:
"http://127.0.0.1:<port>" } } } } }`. The vendor reference
(tailscale.com/kb/1242/tailscale-serve, read the same day) states that with
`--bg` serve "runs persistently in the background until you disable it" and
"automatically resumes sharing" after a reboot or `tailscale down` / `up`,
that without `--bg` it must be restarted by hand, and that a configuration is
removed by appending `off` to the command that created it (`tailscale serve
--https=443 <target> off`) or wholesale by `tailscale serve reset`. On this
machine the 443 handler currently proxies to a local port that is not the
Viewer's, so "serve is on, for something else" is a state the button will
meet, not a hypothetical. The container image installs no `tailscale`
(`Dockerfile` names none), so inside it the step reads `missing`.

**The QR button prints the command it should replace.**
`src/components/AccessQrButton.tsx:143-149` renders `qr.startHint` plus `bunx
agent-log-viewer --tailscale` when `/api/access` answers a null URL. The
desktop rail menu has the row `rail.menuQr` (`ProjectRail.tsx:418-419`); the
phone menus (`ProjectDashboard.tsx:1934-2007`, `OverviewBoard.tsx:185-191`)
have no QR row.

**Transcription: the backend has a route, the keys have none.**
`src/lib/transcribeBackend.ts`: `resolveTranscribeBackend` (24-34) reads
`LLV_TRANSCRIBE_BACKEND`, then the `transcribe-backend` file, then `local`;
`writeTranscribeBackend` (37-41) writes that file with the default mode;
`transcribeBackendInfo` (58-70) reports `available` and `keyPath` per option;
`readElevenLabsApiKey` / `readSonioxApiKey` (78-99) read the env variable
first and then `elevenlabs-api-key` / `soniox-api-key`, on every request.
`GET` and `POST /api/transcribe/backend` (`backend/route.ts:17`, `22-45`)
report and persist the backend and answer 409 when the env locks it (35). No
route writes a key: the mic menu's key popup (`MicButton.tsx:204-215`) shows
the file path to copy and leaves the write to the user. `POST
/api/transcribe/token` (`token/route.ts:30-41`) answers 409 for `local` and
`chatgpt`, 503 when the live backend has no key (46-51, 77-82), 502 when the
provider refuses, and `{ token, provider }` on success; the batch route's
ChatGPT path (`transcribe/route.ts:101-113`) answers 502 when the Codex token
is missing or expired.

**Accounts: the add row exists and the Engines step hides it.**
`MobileAddAccountRow` (`AccountsPanel.tsx:1295`) is the "Add a {engine}
account" row: a label field and Add, calling `state.add(label)`
(`useEngineAccounts.ts:438`); `MobileEngineSection` renders it under every
account card inside `MobileAccountsBody` (1426), with `mobileAccountState`
(1006) giving each row `active | ready | needsSignIn | pending`. `EnginesStep.tsx:108`
already embeds `MobileAccountsBody`, but only behind the "Sign in" toggle
(47, 92) and only while no account is connected. A connected engine shows one
state line and no list.

**The marker and the dialog know three steps.** `ONBOARDING_STEP_IDS`
(`src/lib/onboarding/marker.ts:17`) is `engines, agents, check`;
`parseMarker` drops ids it does not know; `useOnboarding.ts:79` writes
`engines` and `agents` as done on completion; `OnboardingDialog.tsx:27`
carries the same three in `STEPS`. `openOnboarding(mode)` takes `guide |
mapping` and no target step.

**The seat and the tour's first action.** `toggleOrchestrator`
(`Viewer.tsx:404`) opens the dock for the current project;
`focusHandoffBus.setShell` (743) exposes `openProject`. The dock's create
draft opens at `ORCHESTRATOR_SPAWN_CONFIG` = Claude Opus at `low`
(`src/lib/orchestrator/prompt.ts:60-63`), while the Orchestrator role preset
is Opus at `high` (`src/lib/roles/defaults.ts:42-45`); `docs/orchestrator.md:32-60`
describes the dock and the draft, and `README.md:93-122` the tasks, pipelines
and seat in the product's words. The wake numbers stay where card 4 of the
first revision read them: `seatTick.ts:129` (5-minute check), `105` (hourly
bound), `125`/`126` (5 and 15 minutes for the seat's own children). The
attention island's label is `attention.needsYou` (`en.ts:2292`). A fail
edge's `maxRounds` is the review budget (`src/lib/pipelines/types.ts:82`).

**One evidence driver already renders the guide at all three widths.**
`scripts/capture-board-geometry.ts:554-583` holds the `onboarding` case with
`ONBOARDING_VIEWPORTS` = 1440×900, 1280×900, 390×844, light and dark, EN and
UK, over a seeded home with stub CLIs. Slice 3 adds its states there and
writes no new driver.

## 2. The flow

One dialog, six steps, one job each. No welcome screen and no finish screen:
the first step is useful at once and the last step's result is the ending.

```
1 Engines  →  2 Agents  →  3 Phone  →  4 Voice  →  5 Tour  →  6 Check
```

Voice sits beside Phone because both are "this device" steps; the tour is
the last thing read before the check, and the seat its card 5 creates is
what the check's row 5 then looks at. Slices 1 and 2 shipped "Step {n} of 3";
slice 3 makes it 6 and inserts three ids into `ONBOARDING_STEP_IDS`
(`marker.ts:17`) and `STEPS` (`OnboardingDialog.tsx:27`). A marker written by
an earlier build reads the new ids as `null`, which is the "not visited"
state, so `firstOpenStep` lands a returning user on Phone.

Shared chrome, all steps:

| Control | EN | UK |
|---|---|---|
| Dialog title | Set up Agent Log Viewer | Налаштування Agent Log Viewer |
| Step counter | Step {n} of 6 | Крок {n} з 6 |
| Primary | Continue | Далі |
| Back | Back | Назад |
| Leave | Close, finish later | Закрити, завершити пізніше |
| Leave hint (tooltip, once) | You can reopen this from the menu: Setup guide | Відкрити знову можна з меню: «Посібник із налаштування» |
| Step names | Engines · Agents · Phone · Voice · Tour · Check | Рушії · Агенти · Телефон · Голос · Огляд · Перевірка |

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

**Several accounts per engine (slice 3, #2004).** The card stops being one
state line with a hidden sign-in and becomes the engine's account list. Under
the header line, every account the engine store knows is a row: label, the
state chip `mobileAccountState` already computes (`AccountsPanel.tsx:1006`:
active · ready · sign in · signing in), the plan when read, and the row's
own "sign in" where it applies (the Claude browser-and-code flow, the Codex
device code, both from `MobileEngineSection`). The last row is "Add a
{engine} account" (`MobileAddAccountRow`, `AccountsPanel.tsx:1295`): tapping
it turns it into the label field and Add, which calls `state.add(label)` and
starts the sign-in the engine uses. Nothing here is new UI: `EnginesStep` renders
`MobileAccountsBody engines={[state]}` always instead of behind the "Sign in"
toggle (`EnginesStep.tsx:47, 92, 108`), and the toggle button goes away. The
header line summarises the list so the card reads at a glance:

| Element | EN | UK |
|---|---|---|
| Header, one connected | Connected · {plan} | Підключено · {plan} |
| Header, several | {count} accounts · {label} is active | Акаунтів: {count} · активний — {label} |
| Header, connected plus one signed out | {count} accounts · {label} is active · 1 needs sign-in | Акаунтів: {count} · активний — {label} · 1 без входу |
| Add row (existing keys) | Add a {engine} account / opens the device sign-in | Додати акаунт {engine} / відкриває вхід через код |

"Active" is the account future launches use (`select`, the row's own
control); the row already says "Use {label} for future launches" on tap. The
project binding of #1279 stays in the accounts panel: the step says which
account launches use by default, and a project that binds another account is
that panel's business (§8). Rows are 56 px (`min-h-14`) inside the 328 px
desktop card, which the existing row layout already fits (it was drawn for
358 px); the card grows and the step body scrolls.

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

**One job:** one press turns phone access on from the running Viewer and
comes back with the link and the QR; or the user says "not now" in one tap.

The old revision made the step a set of terminal commands because "the
Viewer cannot enable remote access for itself" (§1). It can: every part of
the gate is read per request (§1.1), Tailscale has a background serve mode
that outlives the process that set it, and the launcher can read one file
before it decides its options. The step reads the state, shows one button
for it, and never shows a command on the happy path.

#### The state the button finds

`GET /api/access` grows from `{ tailnetUrl }` to:

```
{ tailnetUrl: string | null,
  phone: { state: "missing" | "needs-login" | "no-dns" | "ready" | "serving-other" | "serving",
           dnsName: string | null, viewerPort: number, servingPort: number | null,
           persisted: boolean } }
```

The route calls `detectTailscale`, `readStatus` and a new `serveStatus`
from `bin/tailscale.mjs`, each bounded to 3 s, and maps:

| State | Read as | The step shows |
|---|---|---|
| `missing` | `detectTailscale` throws | one sentence, one link |
| `needs-login` | `tailscale status --json` has any `BackendState` other than `Running` (`NeedsLogin`, `Stopped`, `NoState`, `NeedsMachineAuth`, `Starting`); `readStatus` already raises for the first two (`tailscale.mjs:207`) | one sentence, one link |
| `no-dns` | `Running` and `Self.DNSName` empty (`readStatus`'s MagicDNS error) | one sentence, one link |
| `ready` | `Running` with a DNS name; `serve status` has no `/` handler on 443, or has one that proxies to the Viewer's own port while this process holds no `LLV_TOKEN` (a `--bg` mapping left by an earlier run) | the button |
| `serving-other` | the 443 `/` handler proxies to a local port that is not `viewerPort` | the button, with one warning line |
| `serving` | the 443 `/` handler proxies to `127.0.0.1:<viewerPort>` **and** this process holds `LLV_TOKEN` and `LLV_TS_URL` | the QR, the link, Copy |

`viewerPort` is `process.env.PORT` (set by `buildChildEnv`, `cli.mjs:308`)
or the listening port the server reports. `persisted` is whether the flag
file below exists, so the serving state can say "remembered for future
starts". In `missing`, `needs-login` and `no-dns` the step re-reads the
state every 5 s while it is on screen, so the user who installs or signs in
sees the button appear without pressing anything; that is what lets those
states carry a sentence and a link and nothing else.

#### What the one press does

`POST /api/access/phone` with `{ action: "enable" }`, guarded by
`rejectCrossOrigin`, bounded to 15 s as a whole, runs these in order and
stops at the first failure, so a failed press leaves the process exactly as
it was:

1. **Persist the choice.** Write `<config>/agent-log-viewer/phone-access`
   containing `tailscale\n` (the same directory as `token`, resolved through
   `configFilePath`). `bin/cli.mjs` reads this file before `parseArgs`
   decides and treats its presence as `--tailscale`; §7 has the launcher
   side. Failure code `PERSIST_FAILED`.
2. **Read or mint the token.** `getToken()` from `bin/tailscale.mjs`: the
   existing 32-hex file, mode 600, reused when present, never rotated from
   here. Failure code `TOKEN_WRITE_FAILED` (its own message names the path).
3. **Publish in the tailnet.** Spawn `tailscale serve --bg <viewerPort>`
   through `viewerChildProcessOptions` (the credential isolation
   `tailscale-credential-isolation.test.ts` pins) and wait for it to exit,
   bounded 10 s. Stderr matching the operator pattern of `tailscale.mjs:237`
   is `OPERATOR_RIGHTS`; any other non-zero exit is `SERVE_FAILED` with the
   last stderr line; no exit in time is `TIMEOUT`. With `--bg` the mapping is
   tailscaled's, not this process's: it survives the Viewer, the launcher and
   a reboot (§1.1), which is the "persist" the requirement asks for on the
   tailnet side.
4. **Verify.** `tailscale serve status --json` must show the 443 `/` handler
   proxying to `127.0.0.1:<viewerPort>`; otherwise `VERIFY_FAILED`. A
   `serving-other` mapping is replaced by step 3, which the step's warning
   line said before the press.
5. **Re-bind the running process.** Set `process.env.LLV_TOKEN`,
   `LLV_TS_HOST = <dnsName>` and `LLV_TS_URL = https://<dnsName>/?k=<token>`
   in the serving Viewer. From the next request `proxy.ts:50` gates every
   connection, `sameOrigin.ts:34` admits the tailnet host, and
   `/api/access` answers the URL. No restart: nothing in the gate is read at
   boot, and a restart would end the launcher (§1.1). This is the "re-bind"
   the requirement allows, chosen over "restart" because the process cannot
   restart itself and stay alive.
6. **Keep the caller signed in.** The JSON reply sets the `llv_auth` cookie
   with the attributes `redirectWithCookie` uses (`proxy.ts:23-32`), so the
   tab that pressed the button survives the gate it just turned on; other
   tabs of the same browser share the cookie. Another browser on the same
   computer now meets the 403 page and needs the link once; the serving
   state says so in one line.
7. **Answer** the new `GET /api/access` body; the client renders the QR from
   `tailnetUrl` with the same client-side `qrcode` path `AccessQrButton`
   uses today (the token never reaches a server log or an image service).

`{ action: "disable" }` is the secondary affordance in the serving state:
it removes the flag file, runs `tailscale serve --https=443 <viewerPort>
off` (the vendor-documented removal form, §1.1), and clears the three
variables from `process.env`; the loopback gate lifts on the next request
and the cookie becomes inert. It never deletes the token file, so a later
enable hands out the same link and every phone that scanned it stays signed
in.

The route is the one place that runs `tailscale` from the Viewer, and it
runs it with argv only: no shell, the port as a number, the binary from
`detectTailscale`. A request from the tailnet itself (the phone) is allowed
to disable and to enable; nothing about it is riskier than the desktop tab,
since both already hold the token.

#### Copy

| Element | EN | UK |
|---|---|---|
| Heading | Open it on your phone | Відкрити на телефоні |
| Lead | The Viewer stays on this computer. Your phone reaches it over your own Tailscale network, and a secret key in the link keeps everyone else out. | Viewer лишається на цьому комп'ютері. Телефон підключається через вашу власну мережу Tailscale, а секретний ключ у посиланні не пускає сторонніх. |
| Skip | Not now | Не зараз |
| missing: sentence | Install Tailscale on this computer and on your phone, then come back to this step. | Встановіть Tailscale на цьому комп'ютері й на телефоні, потім поверніться до цього кроку. |
| missing: link | Get Tailscale → `https://tailscale.com/download` | Завантажити Tailscale → same |
| needs-login: sentence | Tailscale is installed here and not signed in; sign in on this computer and this step continues by itself. | Tailscale встановлено, але вхід не виконано; увійдіть на цьому комп'ютері, і цей крок продовжиться сам. |
| needs-login: link | How to sign in → `https://tailscale.com/kb/1017/install` | Як увійти → same |
| no-dns: sentence | Turn on MagicDNS and HTTPS certificates for your Tailscale network, then come back to this step. | Увімкніть MagicDNS і HTTPS-сертифікати для своєї мережі Tailscale, потім поверніться до цього кроку. |
| no-dns: link | Open the DNS settings → `https://login.tailscale.com/admin/dns` | Відкрити налаштування DNS → same |
| ready: title | Tailscale is signed in on this computer. | Tailscale на цьому комп'ютері готовий. |
| ready: button (primary) | Turn on phone access | Увімкнути доступ із телефона |
| ready: under the button | Publishes the Viewer inside your Tailscale network only, protects it with an access key, and remembers the choice for future starts. | Публікує Viewer лише всередині вашої мережі Tailscale, захищає ключем доступу й запам'ятовує вибір для наступних запусків. |
| busy: button | Turning on… | Вмикаю… |
| busy: line | This takes a few seconds. | Це триває кілька секунд. |
| serving-other: title | Tailscale already publishes another local port ({port}) at this computer's address. | Tailscale уже публікує за адресою цього комп'ютера інший локальний порт ({port}). |
| serving-other: button | Point it at the Viewer | Перенаправити на Viewer |
| serving-other: warning | That other service stops being reachable at the Tailscale address. | Той інший сервіс перестане відкриватися за адресою Tailscale. |
| serving: title | Ready. Scan with your phone's camera | Готово. Наведіть камеру телефона |
| serving: note | The phone must be signed in to the same Tailscale network. The link holds your access key: share it with nobody. | Телефон має бути в тій самій мережі Tailscale. У посиланні — ваш ключ доступу: нікому його не передавайте. |
| serving: gate line | Other browsers on this computer now need this link too: the Viewer asks every connection for the key. | Іншим браузерам на цьому комп'ютері тепер теж потрібне це посилання: Viewer запитує ключ у кожного підключення. |
| serving: persisted line | Phone access stays on the next time you start the Viewer. | Доступ із телефона лишиться увімкненим і після наступного запуску Viewer. |
| serving: actions | Copy link · Turn off phone access | Скопіювати посилання · Вимкнути доступ із телефона |
| copied | Copied | Скопійовано |
| error: read | Could not read the access state. | Не вдалося прочитати стан доступу. |
| retry | Try again | Спробувати ще раз |

Failure copy, shown under the button in a `danger-soft` block with "Try
again"; the code goes into a "Show details" disclosure with the stderr tail,
never into the sentence:

| Code | EN | UK |
|---|---|---|
| `OPERATOR_RIGHTS` | Tailscale lets only an operator publish services. Run this once in a terminal, then press the button again: `sudo tailscale set --operator=$USER` | Tailscale дозволяє публікувати сервіси лише оператору. Виконайте це один раз у терміналі й натисніть кнопку знову: `sudo tailscale set --operator=$USER` |
| `SERVE_FAILED` | Tailscale could not publish the Viewer: {detail}. | Tailscale не зміг опублікувати Viewer: {detail}. |
| `VERIFY_FAILED` | Tailscale reported success, and the published address does not point at the Viewer yet. Try again in a moment. | Tailscale повідомив про успіх, але опублікована адреса ще не вказує на Viewer. Спробуйте за хвилину. |
| `TIMEOUT` | Tailscale did not answer within 15 seconds. | Tailscale не відповів за 15 секунд. |
| `TOKEN_WRITE_FAILED` | Could not save the access key: {detail}. | Не вдалося зберегти ключ доступу: {detail}. |
| `PERSIST_FAILED` | Could not remember the choice: {detail}. Nothing was turned on. | Не вдалося запам'ятати вибір: {detail}. Нічого не ввімкнено. |
| `STATUS_UNREADABLE` | Could not read Tailscale's state. | Не вдалося прочитати стан Tailscale. |
| `DISABLE_FAILED` | Could not turn phone access off: {detail}. The link still works. | Не вдалося вимкнути доступ із телефона: {detail}. Посилання досі працює. |

`OPERATOR_RIGHTS` is the one place a terminal command appears, and it is a
failure path: granting the operator right needs `sudo`, which no web request
may run. The command is the same one `bin/tailscale.mjs` prints today
(`OPERATOR_HINT`).

#### The rest of the surface

- The QR body (image, link field, Copy) is extracted from `AccessQrButton`
  into `AccessQrBody`, used by the step and the popover. The popover's
  unavailable state (`AccessQrButton.tsx:143-149`) drops the command and
  shows one button, "Turn on phone access" / «Увімкнути доступ із
  телефона», which opens the guide on this step (`openOnboarding("guide",
  "phone")`); `qr.startHint` is retired. The rail menu row `rail.menuQr`
  keeps opening the popover.
- Skipped when the wizard is open on a phone over the tailnet
  (`useIsMobile()` and a host that is not loopback): "You are already here
  on your phone." / «Ви вже відкрили Viewer на телефоні.», marked skipped.
  "Not now" marks the step skipped and continues. Inside the container image
  the state is `missing` and the sentence stands as written.
- The "other private network" and "new key" disclosures of the first
  revision are gone from the step: `--hostname` and `--new-token` stay
  launcher flags documented in the README, and the step's job is one button.

### 2.4 Step 5 — Tour

**One job:** one screen that says, in the product's own words, what Agent
Log Viewer is and what to do first, readable in under a minute.

The first revision's tour walked the screens (board, tasks, pipelines, seat,
review rounds). The operator's framing for this slice is different and this
rewrite follows it: the product is an orchestrator of coding agents for
development work; everything revolves around tasks on the kanban board; the
seat runs everything; pipelines and review rounds are how work moves; and
the tour ends on the first action, creating the first seat in a project the
Viewer already lists. README keeps the depth and the tour links to it.

One screen. Four cards in a row on desktop and one "Start here" band under
them; on the phone a horizontal snap pager whose last page is the band. Each
card: a 16:10 schematic drawn with the app's own tokens (inline SVG, no
screenshots, no animation), a title, at most four lines of body. The bodies
below are held to 150 characters in both locales (`TourStep.dom.test.tsx`),
which is what keeps the Ukrainian tour, links included, inside one screen at
1280. No overlays
on the live UI, no coach marks. Cards 1–4 are static and work offline; card
5 reads the project list the rail already holds.

| # | Title EN / UK | Body EN | Body UK |
|---|---|---|---|
| 1 | An orchestrator for coding agents / Оркестратор для агентів-розробників | It runs coding agents on this computer. The work is tasks on each project's board; agents, pipelines and reviews attach to a task. | Запускає агентів-розробників на цьому комп'ютері. Робота — це завдання на дошці проєкту; агенти, конвеєри й рев'ю прикріплюються до завдання. |
| 2 | The orchestrator seat / Місце оркестратора | One agent per project runs tasks, pipelines and agents. It sleeps; the Viewer wakes it every {check} minutes, when a stage ends, or when you write. | Один агент на проєкт веде завдання, конвеєри й агентів. Між кроками він спить; Viewer будить його кожні {check} хв, коли етап завершився або ви написали. |
| 3 | Pipelines and review rounds / Конвеєри й раунди рев'ю | A pipeline takes a task through stages: build, review, verify. Fail sends it back for another round; needs-decision stops and asks you. | Конвеєр веде завдання етапами: розробка, рев'ю, перевірка. «Не пройдено» повертає на ще один раунд; «Потрібне рішення» питає вас. |
| 4 | Where things wait for you / Де щось чекає на вас | "Needs you" in the corner counts what waits for your answer. Press it to jump there; everything else runs without you. | «Потрібні ви» в кутку рахує все, що чекає на вашу відповідь. Натисніть, щоб перейти; решта працює без вас. |
| 5 | Start here: the first orchestrator / Почніть тут: перший оркестратор | Pick a project and the effort. The seat's draft opens with its instructions written; its own Create starts the orchestrator. | Виберіть проєкт і рівень зусилля. Відкриється чернетка місця з готовими інструкціями; її власне «Створити» запускає оркестратора. |

Card 2's `{check}` is `DEFAULT_SEAT_TICK_POLICY.checkIntervalMs`
(`seatTick.ts:129`) at render, as before; the hourly and 15-minute bounds
(`seatTick.ts:105, 126`) are left to the README, since the card's job is the
mechanism, not the schedule. Card 3 leaves the round budget
(`maxRounds` on the fail edge, `types.ts:82`) to the README. Card 4 uses the
attention island's own word (`attention.needsYou`), so the word on the card
is the word on the screen.

Links, under the cards, 12 px `text-secondary` with the arrow glyph:

| Link | EN | UK | Target |
|---|---|---|---|
| Full guide | Read the full guide on GitHub | Повний посібник на GitHub | `https://github.com/Latand/live-log-viewer-next#how-agents-are-driven` (`package.json` repository) |
| Seat guide | How the orchestrator works | Як працює оркестратор | `…/blob/main/docs/orchestrator.md` |

#### Card 5's controls (the first action)

| Element | EN | UK |
|---|---|---|
| Project select | Project | Проєкт |
| Select, no projects | No projects yet. Open a folder with a repository first: the board's "Create a project". | Проєктів ще немає. Спершу відкрийте теку з репозиторієм: «Створити проєкт» на дошці. |
| Effort segment | High (recommended) · Medium | High (рекомендовано) · Medium |
| Effort note | Opus at high effort thinks longer per step; medium is cheaper and fine for small projects. | Opus на high думає довше на кожному кроці; medium дешевший і достатній для невеликих проєктів. |
| Button | Open the orchestrator draft | Відкрити чернетку оркестратора |
| Already has one | {project} already has an orchestrator. Open it | У проєкту {project} уже є оркестратор. Відкрити |
| Claude not connected | The orchestrator runs on Claude, which is not connected (step 1). | Оркестратор працює на Claude, який не підключено (крок 1). |

The select lists the projects the rail has (`projectCatalog`, existing
folders first, the overview and archived projects excluded), preselecting
the one the wizard opened over. Pressing Create does **not** spawn anything:
it closes the wizard (writing `tour: "done"`), opens that project through
the shell bus (`focusHandoffBus.setShell().openProject`, `Viewer.tsx:743`),
opens the dock (`toggleOrchestrator`, `Viewer.tsx:404`) and hands the create
draft `engine: "claude", model: "opus"` and the chosen effort. The draft's
own Confirm is what designates the seat and delivers the mandate, exactly as
`docs/orchestrator.md:32-60` describes; the tour only removes the finding
and the choosing. On the phone the same press pushes the orchestrator screen
(`MobileOrchestratorSheet`) for that project with the same prefill. The
draft today opens at `low` (`prompt.ts:60-63`); the tour passes `high` or
`medium` per the operator's ask, and the build gives the draft an `initialEffort`
input rather than changing `ORCHESTRATOR_SPAWN_CONFIG`, so nothing else that
opens the draft moves. A project that already holds a seat shows the
"already has one" line and "Open it" in place of Create.

#### Schematics

Inline SVG, `viewBox="0 0 160 100"`, strokes `currentColor` at 1.5 px on
`text-muted`, fills from the tokens (`--color-accent`, `--color-success`,
`--color-warning`, `--color-danger`, `--color-sunken`); no text inside the
pictures, so nothing needs translating and nothing can overflow:

1. **Board.** Three columns (`x` 8, 58, 108; width 44; height 84, `--color-sunken`),
   five cards across them (12 × 44 rounded rects), two with a 3 px left bar
   in `--color-accent` and one in `--color-success`.
2. **Seat.** A filled circle at (80, 50) r 14 in `--color-accent`; four
   small cards around it at the corners; arrows from the circle to each
   card; a dashed arrow from the bottom edge (a message) into the circle; a
   small "z" made of three shortening strokes above the circle for sleep.
3. **Pipeline.** Three boxes in a row (build, review, verify: `x` 10, 60,
   110; 40 × 26 at `y` 30) joined by arrows; a curved arrow from box 2 back
   over box 1 in `--color-warning` (the fail edge) with a small "×2" made of
   two ticks; a diamond under box 2 in `--color-danger` (needs decision).
4. **Needs you.** A rounded rectangle for the board with a small pill at the
   top-right corner in `--color-danger` holding a filled dot; three dotted
   lines from cards on the board converging on the pill.
5. **Start here.** A project card (`--color-sunken`) with a "+" seat circle
   in `--color-accent` at its corner and a short arrow from the circle into
   an empty conversation box.

Controls: Back / Continue, the links, and card 5's three controls; on the
phone, the pager dots and swipe. Empty/error: card 5 with no projects shows
its own line. Skipped when: never auto-skipped; one click passes it.

### 2.5 Step 6 — Check

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

The four footer lines are one sentence apart. "Fix that, then run it again"
is only written under a failure the user can act on; `DELIVERY_FAILED`,
`WAKE_NOT_OWED`, `WAKE_UNDELIVERED` and `SEAT_UNREADABLE` say to copy the
details into a bug report, so their footer states where the check stopped and
stops there. `RUN_BOUND` takes a footer of its own, ahead of both: the
whole-run bound belongs to the run rather than to the row it happened to stop,
and it is the one failure that can land on the first row as well as any later
one.

While the check runs, no control on the screen is filled: the step's own button
is "Stop" and the footer's "Open the board" steps back to a border, so the
brightest thing during a two-minute wait is not the control that leaves. A
failed row's state word carries `text-danger` with its glyph.

"Open the board" writes `completedAt` and closes the dialog. It is enabled
whatever the check's result, including never run.

### 2.6 Step 4 — Voice (transcription)

**One job:** pick where dictation is transcribed, paste the key if that
place needs one, and prove in one press that it answers.

Reads `GET /api/transcribe/backend` (`backend/route.ts:17`): the current
backend, whether the environment locks it, and per option `available` and
`keyPath`. Four rows, one radio each, in the order the store lists them
(`TRANSCRIBE_BACKENDS`). Choosing a row calls the existing `POST
/api/transcribe/backend` (22-45) at once; there is no Save. The two live
rows carry a key field.

| Element | EN | UK |
|---|---|---|
| Heading | Where your dictation is transcribed | Де розпізнається ваше диктування |
| Lead | The microphone in the composer turns speech into the message. Choose what does the transcribing; the local option keeps every recording on this computer. | Мікрофон у полі вводу перетворює мову на повідомлення. Оберіть, що розпізнаватиме; локальний варіант лишає кожен запис на цьому комп'ютері. |
| Row: local | Faster Whisper (local) · nothing leaves this computer | Faster Whisper (локально) · нічого не виходить за межі цього комп'ютера |
| local, not installed | Not installed on this computer. How to install → docs/transcription.md#local | На цьому комп'ютері не встановлено. Як встановити → same |
| Row: chatgpt | ChatGPT Voice · through your Codex sign-in, after you stop recording | ChatGPT Voice · через ваш вхід у Codex, після зупинки запису |
| chatgpt, no Codex | Sign in to Codex first (step 1). | Спершу увійдіть у Codex (крок 1). |
| Row: elevenlabs | ElevenLabs Scribe · live, while you speak · needs an API key | ElevenLabs Scribe · наживо, поки говорите · потрібен API-ключ |
| Row: soniox | Soniox · live, while you speak · needs an API key | Soniox · наживо, поки говорите · потрібен API-ключ |
| Key field (label) | API key | API-ключ |
| Key field (placeholder) | Paste the key | Вставте ключ |
| Key save | Save key | Зберегти ключ |
| Key on file | Key on file · Replace | Ключ збережено · Замінити |
| Key from environment | Key comes from the environment ({var}); it cannot be changed here. | Ключ береться зі змінної середовища ({var}); тут його змінити не можна. |
| Key saved receipt | Key saved. It is never shown again. | Ключ збережено. Більше він не показується. |
| Key save failed | Could not save the key: {reason}. | Не вдалося зберегти ключ: {reason}. |
| Locked by env | Locked by LLV_TRANSCRIBE_BACKEND on this machine; the choice here is read-only. | Заблоковано змінною LLV_TRANSCRIBE_BACKEND на цьому комп'ютері; вибір тут лише для читання. |
| Check | Check dictation | Перевірити диктування |
| Checking | Checking… | Перевіряю… |
| Skip | Keep the local default | Лишити локальний варіант |

The **Check** calls the real path and reports its answer in one sentence,
in `text-success` or `text-danger`:

| Backend | Call | Answer | Sentence EN | Sentence UK |
|---|---|---|---|---|
| elevenlabs, soniox | `POST /api/transcribe/token` | 200 `{ provider }` | Live dictation works with {name}. | Диктування наживо працює з {name}. |
| same | same | 503 (no key, `token/route.ts:46-51, 77-82`) | No key on file for {name}. Paste it above and save. | Для {name} немає ключа. Вставте його вище й збережіть. |
| same | same | 502 (provider refused) | {name} refused the key: {detail}. | {name} відхилив ключ: {detail}. |
| local | `GET /api/transcribe/backend`, `available` | true | Dictation works with Faster Whisper on this computer. Speech is transcribed after you stop. | Диктування працює з Faster Whisper на цьому комп'ютері. Мова розпізнається після зупинки. |
| local | same | false | Faster Whisper is not installed on this computer. | Faster Whisper на цьому комп'ютері не встановлено. |
| chatgpt | same | true | Dictation works through your Codex sign-in. Speech is transcribed after you stop. | Диктування працює через ваш вхід у Codex. Мова розпізнається після зупинки. |
| chatgpt | same | false | No signed-in Codex account. | Немає акаунта Codex із виконаним входом. |
| any | network or 5xx | | Could not check: {reason}. | Не вдалося перевірити: {reason}. |

The token route answers 409 for `local` and `chatgpt` by design
(`token/route.ts:33-38`: live mode is ElevenLabs and Soniox only), so for
those two the check reads availability from the backend route and the
sentence says "after you stop"; the client falls back to record-then-transcribe on any non-200, as the route's own comment says (`token/route.ts:12-16`).
The check for ChatGPT proves a credential file, not a live token: an expired
token surfaces at the first dictation as the 502 the batch route already
answers (`transcribe/route.ts:110`), and the sentence does not claim more.

**Writes.** The backend goes through the existing `POST
/api/transcribe/backend`; `writeTranscribeBackend` (37-41) gains `{ mode:
0o600 }` and a `chmod`, so all three files carry the mode the requirement
names. The keys go through a new `PUT /api/transcribe/key` with `{
provider: "elevenlabs" | "soniox", key }`: `rejectCrossOrigin`; the key
trimmed, 1–512 characters, no line break; written to
`configFilePath("<provider>-api-key")` through a temp file and rename, mode
600 plus `chmod`; the reply is `transcribeBackendInfo()` (availability and
paths, never the key); the handler never logs the body and the client never
keeps it after the reply. A provider whose key comes from the environment
(`readElevenLabsApiKey` / `readSonioxApiKey` read the variable first,
`transcribeBackend.ts:79-80, 91-92`) answers 409 `KEY_FROM_ENV`, and the
field is disabled with the "from the environment" line. `GET` on that path
does not exist: there is nothing to read back.

**Reachable later.** A third row in both menus beside "Setup guide" and
"Agent mapping": "Dictation" / «Диктування», opening this step alone in the
same shell the mapping uses (`OnboardingMode` gains `voice`). The mic menu's
key popup (`MicButton.tsx:204-215`) keeps the copyable path and gains one
button, "Set up in the guide" / «Налаштувати в посібнику», that opens the
same. `docs/transcription.md:62-68` ("the cloud backends stay off the UI on
purpose … no in-app toggle") is already false since the mic menu shipped
and becomes more so; the build rewrites that paragraph.

Controls per row are 44 px on the phone and the key field is 16 px there
(the iOS no-zoom rule `MobileAddAccountRow` already follows). Skipped when:
never auto-skipped; "Keep the local default" marks it skipped and continues,
and the local row stays selected. The control is shown only while local is
the selected row: picking another backend saves it at once, and Continue is
then the way on.

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
│ ○ 4 Voice     │  ┌ banner: warning-soft, 12 px pad ───────────────────┐  │
│ ○ 5 Tour      │  │ 5 roles run on Codex, which is not connected. …    │  │
│ ○ 6 Check     │  │ [Move them to Claude] [Connect Codex] Leave as is  │  │
│               │  └────────────────────────────────────────────────────┘  │
│  200 px       │  ROLE            ENGINE        MODEL      EFFORT   COST  │ 11/600 muted
│  bg-sunken    │  BUILD                                                   │
│  border-r     │  Builder         [Cl│Cx]   [GPT-6-Astra▾] ▮▮▯▯   heavy  │ 44 row
│               │  Builder, front  [Cl│Cx]   [Opus 5     ▾] ▮▮▮▯▯  heavy  │
│               │  …                                     content 720 px    │
├───────────────┴──────────────────────────────────────────────────────────┤
│ Step 2 of 6                                        [ Back ] [ Continue ] │ 60  bg-raised, border-t
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
- Step list: six rows of 36 px (216 px plus padding) inside the 528 px the
  body has between header and footer, so the list never scrolls.
- Engines step: the two cards keep their 328 px columns; each now holds the
  account rows (56 px each) and the add row, so a card is 56 × (n + 1) + 64
  px tall and the body scrolls past ~5 accounts. The header line truncates
  with an ellipsis; the row labels are the panel's own.
- Phone step, `ready` and `serving-other`: one column, 480 px wide, the
  title 15 / 700, the button 32 px `accent` fill under it with the note in
  12 px `text-secondary`; the failure block (`danger-soft`, 12 px padding)
  appears under the note and pushes nothing off screen at 640 px. `serving`:
  two columns, the 240 × 240 QR well on `bg-sunken` at the left, title, note,
  gate line, persisted line and the two actions at the right. `missing`,
  `needs-login`, `no-dns`: one sentence (13 / 400) and one link (12 / 600
  `text-accent`), nothing else; the column is 480 px so the sentence wraps
  to two lines at most in Ukrainian.
- Voice step: four rows of 44 px with the radio at the left, the name
  13 / 600 and the note 12 px `text-secondary` on one line; a selected live
  row opens to 96 px to hold the key field (32 px, `font-mono` off, the key
  is a password input) and "Save key". "Check dictation" is a bordered
  button under the rows; its sentence sits beside it at 13 px and wraps
  under it when longer than the remaining width.
- Tour: cards 1–4 in one row, 160 px wide, 8 px gaps (664 of 672); picture
  160 × 100 on `bg-sunken`, title 12 / 600, body 12 / 400 `text-secondary`
  at up to four lines. Card 5 is a full-width band (672 × 112) under them
  with the `accent-soft` frame: its schematic at the left (128 × 80), the
  title and body, and one row of controls: project select 240 px, effort
  segment 160 px, Create 32 px `accent` fill. The links sit under the band.
  Card 2 keeps the `accent-soft` frame that marked the wake card before.
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
│ ‹  Step 2 of 6 · Agents         ✕ │ 52  bg-raised
│ ▰▰▰▰▱▱▱▱▱▱▱▱ (2 px progress, accent)│
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
  the header line opens the six steps as a `MobileSheetRow` list.
- The mapping table becomes one card per role (the table's five columns cannot
  hold at 358 px of content): title row with the cost chip at the right, then
  engine, model, effort stacked, then the headroom line.
- Engines: the two cards stack. Check: the rows are unchanged at full
  width; the explanation block's action button is full width.
- Phone step on a phone over the tailnet shows the skipped line (§2.3); on
  a phone reached any other way (a dev server on the LAN) it renders the
  one-column layout at full width, the button full width and 44 px.
- Voice: rows 56 px; the open live row stacks the 16 px key field and a
  full-width "Save key"; "Check dictation" is full width and its sentence
  goes under it.
- Tour: the pager has five pages; pages 1–4 are the cards at 358 px with a
  358 × 224 picture; page 5 is the band stacked: picture, title, body, the
  select (44 px), the effort segment (44 px), Create (44 px, full width),
  then the two links. Swipe or Continue advances a page and then the step.
- Engines: the account rows are the panel's own phone rows, unchanged.

Rendered evidence owed by the build: the dialog is a new surface, so each
slice adds a case to the existing drivers and writes no new one: desktop at
1440 and 1280 through `scripts/capture-board-geometry.ts`, the phone at 390
through `src/components/mobile/issue1671Evidence.browser.test.tsx`, light and
dark, EN and UK, with measured overflow checks on the mapping table's longest
Ukrainian labels («Розробник, виправлення», «Аудитор продакшену») and the
footer buttons.

Slice 3 adds its states to the `onboarding` case of
`scripts/capture-board-geometry.ts` (§1.1) and writes no new driver: the
phone step in each of its six states (a stub `tailscale` on the seeded
home's `PATH` answering canned `status` and `serve status` JSON, and
recording the `serve --bg` argv), the press in flight and each failure
code, the voice step with each row selected, a saved key and each check
sentence, the tour with and without projects, the engines step with three
accounts on one engine, and the two new menu rows. Measured in the live DOM
at 1440, 1280 and 390: no horizontal overflow, the longest Ukrainian
controls unclipped («Увімкнути доступ із телефона», «Перенаправити на
Viewer», «Перевірити диктування», «Відкрити чернетку оркестратора»), the four tour
cards in one row at 1280, and 44 px targets on the phone.

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
| 5 | `SEAT_UNREADABLE` | The Viewer could not read the record of your orchestrators, so this row could not be checked. / Viewer не зміг прочитати запис про ваших оркестраторів, тому цей рядок не перевірено. | Restart the Viewer and run the check again. If it repeats, copy the details into a bug report. / Перезапустіть Viewer і запустіть перевірку знову. Якщо повториться, скопіюйте подробиці в повідомлення про помилку. | Copy details |
| any | `RUN_BOUND` | The whole check passed its 5-minute limit while this row was still running. / Уся перевірка вичерпала свої 5 хвилин, поки цей рядок ще виконувався. | Run it again when the machine is less busy. If it stops here again, copy the details into a bug report. / Запустіть її знову, коли комп'ютер буде менш завантажений. Якщо вона знову спиниться тут, скопіюйте подробиці в повідомлення про помилку. | Copy details |

"Copy details" copies the code, both project keys where relevant, the tick
record's verdict and detail, and the Viewer version, passed through
`redactMonitorText`; it contains no account handle, token or home path, so it
is safe to paste into a public issue.

`SEAT_UNREADABLE` is row 5's other outcome and never `SEAT_MISFILED`: when the
seat record cannot be read at all, nothing is known to be misfiled, and the
misfiling sentence names a project the Viewer never learned. `RUN_BOUND` is
what the whole-run bound raises, on whichever row was open when it passed —
including row 1, where a launch that hangs for minutes puts it.

`SEAT_MISFILED` promises a repair. That repair is #1874's fix, on `main`
since: a key a folder has moved on from is recorded as an alias on scan, at
seat tick boot and on every tick sweep, and at designation, so the next check
re-files the seat. Row 5 reads the same judgement (`projectSuccessionFor`) for
every active seat.

## 6. Entry points

**The marker.** `state/onboarding.json`, schema 1:
`{ completedAt, dismissedAt, reason, steps: { engines, agents, phone, voice,
tour, check: "done" | "skipped" | null }, lastHealth: { at, result, failedCode } }`
(slice 3 added `voice`; a file written before it reads the new ids as `null`).
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
`dismissedAt` (the page died mid-wizard) reopens
on the step the `steps` map says is next. Nothing in the app is disabled while
the wizard is unfinished, and the launch refusal of §4.5 works identically
with or without it.

**Re-entry.** Three rows in each menu, since there is no settings page (§1):

| Surface | Row EN / UK | Opens |
|---|---|---|
| Desktop `RailHeaderMenu`, phone `MobileMenuSheet` | Setup guide / Посібник із налаштування | the wizard at step 1, all steps reachable, prior results shown |
| same | Agent mapping / Призначення агентів | the step-2 table alone |
| same | Dictation / Диктування | the Voice step alone (§2.6) |

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

### Slice 3 — phone, tour, voice, accounts (this revision)

What the builder builds, in the order that keeps every intermediate state
green:

1. **The shell.** `ONBOARDING_STEP_IDS` becomes `engines, agents, phone,
   voice, tour, check` (`marker.ts:17`; `parseMarker` and `emptySteps`
   follow); `STEPS` in `OnboardingDialog.tsx` matches; `openOnboarding(mode,
   step?)` gains `voice` as a mode and an optional target step, carried on
   the same window event; `useOnboarding.ts:79` marks every visited step
   rather than two by name; "Step {n} of 6". Tests: the marker round-trips
   the six ids and reads an old three-id file with the new ids `null`; the
   dialog opens on the target step and the `voice` mode shows that step
   alone.
2. **Accounts.** `EnginesStep` renders `MobileAccountsBody` always, drops
   the "Sign in" toggle, and computes the header line from the store (§2.1).
   Test: three accounts on one engine list three rows and the add row; the
   header names the active one.
3. **Voice.** `PUT /api/transcribe/key` and its test (writes mode 600 under
   an isolated `XDG_CONFIG_HOME`, never echoes, 409 from the environment,
   rejects a line break); `writeTranscribeBackend` mode 600; `VoiceStep`
   over the two routes with the check sentences; the "Dictation" menu row
   and the mic popup button. Test: each check sentence against a stubbed
   token route answer (200, 503, 502) and backend availability.
4. **Tour.** `TourStep` with the five schematics, the project select over
   `projectCatalog`, the effort segment, and the create hand-off through the
   shell bus; the dock's create draft accepts `initialEffort`. Test: Create
   opens the chosen project's dock with `opus` and the chosen effort and
   spawns nothing; no projects shows the line; a seated project shows "Open
   it".
5. **Phone.** In `bin/tailscale.mjs`: `serveBackground(tailscalePath,
   port)` (spawn `serve --bg <port>`, resolve on exit with code and stderr),
   `serveStatus(tailscalePath)` (parse `serve status --json` into `{ port
   443: proxied port | null }`), `serveOff(tailscalePath, port)`,
   `phoneAccessFlagPath()`, `readPhoneAccessFlag()`, `writePhoneAccessFlag()`
   and `clearPhoneAccessFlag()`. In `bin/cli.mjs`: read the flag before
   `parseArgs` and set `options.tailscale` from it; when the flag (not the
   argv switch) turned it on, publish with `serveBackground` once after
   readiness instead of the foreground child and leave the mapping in place
   at exit; `--help` names the file. `src/app/api/access/route.ts` answers
   the `phone` block; new `src/app/api/access/phone/route.ts` runs the enable
   and disable sequences of §2.3 and sets the cookie. `AccessQrBody`
   extracted; `PhoneStep`; the popover button. Tests, all against a stub
   `tailscale` binary on an isolated `PATH` and config home: the six states
   from canned JSON; enable writes the flag, reuses an existing token file
   at mode 600, spawns `serve --bg <port>` with argv only, sets the three
   variables only after a verifying `serve status`, and answers with the
   cookie; each failure code from the matching stub behaviour (operator
   stderr, non-zero exit, a stub that never exits, a status that does not
   verify), with `process.env` untouched afterwards; disable clears the
   variables and the flag and keeps the token; `bin/cli.exposure.integration.test.ts`
   gains one case where the flag file and the stub make the real CLI start
   in tailnet mode and answer `/api/access` with the URL once the `?k=`
   cookie is set.
6. **Evidence and docs.** The capture case (§3), `README.md` "Phone access"
   (the button first, the flag as the equivalent) and `docs/transcription.md`
   (§2.6).

Fence:

- `bin/cli.mjs`, `bin/tailscale.mjs`, `bin/tailscale-credential-isolation.test.ts`
  (one case for the background spawn), `bin/cli.exposure.integration.test.ts`
- `src/app/api/access/route.ts`, new `src/app/api/access/phone/route.ts`,
  their tests
- new `src/app/api/transcribe/key/route.ts` and test; `src/lib/transcribeBackend.ts`
  (`writeTranscribeKey`, mode 600 on the backend file) and its test
- `src/components/AccessQrButton.tsx` (extract `AccessQrBody`, the
  unavailable-state button)
- `src/components/onboarding/{PhoneStep,VoiceStep,TourStep}.tsx` and their
  DOM tests; `OnboardingDialog.tsx`, `useOnboarding.ts`, `EnginesStep.tsx`,
  `menuEntries.tsx`
- `src/lib/onboarding/marker.ts` and test
- `src/components/ProjectRail.tsx` (the "Dictation" row), `src/components/MicButton.tsx`
  (one button), `src/components/orchestrator/OrchestratorPanel.tsx` and
  `src/components/mobile/MobileOrchestratorSheet.tsx` (an `initialEffort`
  input for the create draft, nothing else)
- `src/lib/i18n/{en,uk}.ts` (`onboarding.phone.*`, `onboarding.voice.*`,
  `onboarding.tour.*`, `onboarding.engines.accounts*`, `onboarding.menu.voice`,
  the popover button; `qr.startHint` removed from both)
- `scripts/capture-board-geometry.ts` (the onboarding case), `README.md`,
  `docs/transcription.md`

Outside the fence: `src/proxy.ts`, `src/lib/sameOrigin.ts` (both already
read per request and need no change), `src/lib/orchestrator/prompt.ts`
(`ORCHESTRATOR_SPAWN_CONFIG` stays `low`; the tour passes its effort in),
`src/components/AccountsPanel.tsx` (everything the step needs is exported
already), `src/lib/monitor/*`, `src/lib/pipelines/*`. If any of these turns
out to need a change, that is a finding for its own lane.

Gates, every stage of the lane: `bunx tsc --noEmit --incremental false`
logged to a file with its exit code; the touched tests by path with
`LLV_STATE_DIR` and an isolated `HOME`, never the operator's config (#1905);
`bun run build`; the privacy gate from the merge base; `free -m` before each
heavy command, one at a time, none under 4 GB free. The stub `tailscale` is
the only Tailscale the tests ever run: no test and no capture touches the
operator's tailnet or serve configuration, which on this machine carries a
live mapping (§1.1).

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
- **Rotating the access key from the browser.** The one-button phone step
  (§2.3) turns access on and off from the running Viewer, which the operator
  asked for on 2026-09-22 and which reverses the first revision's caution
  here. What survives of that caution: the key is never rotated from a web
  request (`--new-token` stays a launcher flag), the public internet
  (Funnel) is never used, and the route runs `tailscale` with argv only.
- **Showing which account each project will use in the Engines step.**
  #2004 asks for it; the binding is per project (#1279) and the step is per
  install, so it stays in the accounts panel, and the step names the
  account future launches use by default.
- **Removing a saved transcription key from the guide.** Replace covers the
  wrong-key case; deleting the file is the mic menu's path today and stays.
- **A sixth tour card, or a walk through the screens.** The operator's
  framing is the orchestrator, the tasks and the first action; the board and
  the conversation view teach themselves once a seat exists.
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
- **Spawning the first orchestrator from inside the wizard.** The tour's
  card 5 finds the project and prefills the create draft; the draft's own
  Confirm is the paid action, and the wizard never presses it. Creating a
  project stays with the zero-projects panel.
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
| Phone | | | | the whole step, now one button (§2.3) | keeps its place, optional |
| Tour | card 2 states how the seat is woken | | cards 1–4 say what the product is; card 5 is the first action | | keeps its place at five cards |
| Voice (§2.6) | | | the composer's microphone works on the first evening (#2004) | | keeps its place, skippable |
| Add account (§2.1) | | a second account is one row away (#2004) | | | keeps its place |
| Check rows 1–3 | | row 1 names a disconnected engine | | | keeps its place |
| Check rows 4–5 | proves the wake and detects the #1874 condition | | | | keeps its place |
| Marker + re-entry | | | | | required by the issue; three menu rows |

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
