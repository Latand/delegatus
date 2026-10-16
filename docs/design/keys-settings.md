# Keys: every key Delegatus uses, in one Settings section

Status: built as Варіант 1 (see §15). Designed 2026-10-15 in the read-only design stage of the lane
«All keys in one Settings section». No product code is changed here; the
prototype, critic and publish stages that follow render the variants below
and end in a decision form. Every code claim was checked against `origin/main`
at `0ce86fd1a`.

## Originating requirement

Operator, 2026-10-15 ~06:40Z, voice message in Russian, relayed verbatim in
the pinned task specification:

> «нам в настройках, у нас есть сейчас настройки делегатуса, нам нужно иметь
> возможность там где-то место, где вводить все ключи. Чтобы можно было.
> Switch glazic нажать, и его просмотреть, скопировать, или скопировать без.
> Чтобы я мог переносить на другую машину. Чтобы все ключи. Ключи вводились в
> одном месте, а не как сейчас, ключ open router только. То есть там, где у
> нас транскрипции, так там разные environment variables, они должны быть там
> сделаны. Можно сделать прототип, несколько прототипов, я посмотрю картинки.
> Решения.»

What it asks for, point by point:

| # | Ask | Where this design answers it |
|---|-----|------------------------------|
| R1 | One place in Delegatus Settings where every key is entered | §4, §6 (one «Ключі» section replaces the single OpenRouter row) |
| R2 | An eye switch to look at a key | §5 reveal contract, every variant |
| R3 | Copy a key | §5, every variant |
| R4 | «скопировать без» — copy without (looking) | §5; the reading is question Q1 |
| R5 | So the keys can be moved to another machine | §7 move options, every variant |
| R6 | All keys, the transcription ones included, which today are only environment variables | §2 inventory, §4 catalog |
| R7 | Several prototypes as pictures, then decisions | §6 variants, §10 questions |

## 1. What exists today

**Settings** is a page of the header ⋯ menu, a 232 px wide panel on the desktop
(`src/components/ProjectRail.tsx:526`) whose pages keep within 360 px of height
(`HeaderMenu.tsx:176`) and a page of the phone menu
sheet (`HeaderMenu.tsx:345`). Its rows come from
`src/components/headerMenu/headerMenuModel.ts:44` (desktop) and `:52`
(phone). One row is a key: **Ключ OpenRouter** (`HeaderMenu.tsx:130`, phone
`:323`), whose page `KeyPanel` (`src/components/memory/MemoryPage.tsx:243`)
shows its state word, **Замінити** and the write-only field
`OpenRouterKeyField` (`src/components/asks/OpenRouterKeyField.tsx:8`).

Three other keys can be typed into Delegatus, each in its own corner:

- ElevenLabs and Soniox (dictation) in the setup guide's voice step,
  `src/components/onboarding/VoiceStep.tsx:19`, `:118`, through
  `PUT /api/transcribe/key` (`src/app/api/transcribe/key/route.ts:18`).
- OpenAI (voice companion and read-aloud) in the voice companion dialog,
  `src/components/voiceCompanion/VoiceCompanionSetting.tsx:126`, through
  `PUT /api/voice-companion/key` (`src/app/api/voice-companion/key/route.ts:9`).
- Fish Audio has no field at all: environment or a file by hand
  (`src/lib/ttsBackend.ts:63`).

When a dictation key is missing, the error names a file path and a variable
(`src/app/api/transcribe/route.ts:60`, `:78`; `src/app/api/transcribe/token/route.ts:48`, `:81`),
which is the «разные environment variables» the operator meets.

**Every key path is write-only by design.** The reader comments say so in four
places: «never logged, never returned by a route»
(`src/lib/asks/settings.ts:13-17`), «never answered back … There is no GET on
this path» (`src/app/api/transcribe/key/route.ts:12-17`), «Write-only»
(`src/app/api/voice-companion/key/route.ts:8`), «Never read into an input»
(`OpenRouterKeyField.tsx:5-7`). R2–R5 reverse that invariant on purpose. §5
says how far, under which gates, and §9 what it costs.

## 2. Inventory

Values below are placeholders. `<config>` is `$XDG_CONFIG_HOME/delegatus`
(or the older `agent-log-viewer` spelling, `src/lib/configDir.ts:25-48`);
`<state>` is `<config>/state`.

### 2a. API keys Delegatus can hold itself (the section's catalog)

Each one is read the same way: the variable wins, then a file in `<config>`,
read at the moment of the call so a change needs no restart.

| Key | Variable | File | Read at | Written today by | Used by | Portable |
|-----|----------|------|---------|------------------|---------|----------|
| OpenRouter | `OPENROUTER_API_KEY` | `<config>/openrouter-api-key` (0600, atomic) | `src/lib/asks/settings.ts:91-112` | Settings → key page, `src/app/api/asks-you/key/route.ts:15-41`; writer `settings.ts:115-138` | «Питає вас» classifier, shared memory; `scripts/memory-selection.ts:631` (env only) | yes |
| OpenAI | `OPENAI_API_KEY` | `<config>/openai-api-key` (0600) | `src/lib/ttsBackend.ts:59-61`; `src/lib/voiceCompanion/storage.ts:342-371` | voice companion dialog, `voice-companion/key/route.ts:9-19`; writer `storage.ts:347-351` | voice companion (API backend), read-aloud via OpenAI | yes |
| ElevenLabs | `ELEVENLABS_API_KEY` | `<config>/elevenlabs-api-key` (0600) | `src/lib/transcribeBackend.ts:116-125` (TTS reuses it, `ttsBackend.ts:6`) | setup guide voice step, `transcribe/key/route.ts:18-46`; writer `transcribeBackend.ts:74-76` | live dictation, read-aloud | yes |
| Soniox | `SONIOX_API_KEY` | `<config>/soniox-api-key` (0600) | `transcribeBackend.ts:128-137` | same route as ElevenLabs | live dictation, read-aloud | yes |
| Fish Audio | `FISH_AUDIO_API_KEY` | `<config>/fishaudio-api-key` | `ttsBackend.ts:63-65` | nothing (by hand) | read-aloud via Fish Audio | yes |

These five are exactly the names the Viewer lets cross into child processes
(`src/lib/environmentIsolation.ts:4-10`, mirrored in
`bin/server-runtime.mjs:9-12`); every other `*_API_KEY` is dropped. A sixth
row is a key in the same sense, with its own store:

| Key | Variable | Store | Read/written at | Used by | Portable |
|-----|----------|-------|-----------------|---------|----------|
| Telegram bot token | none | `<state>/telegram/bot-token.json` (`{version, botId, token, savedAt}`, owner-only fence) | `src/lib/telegram/bot/transport.ts:147-179`; validated by `getMe` on connect, `src/lib/telegram/bot/service.ts:425-454` | Telegram bot account | yes, with a catch: one bot answers on one machine at a time; a second poller gets the conflict the bot service already reports (`service.ts:358`) |

### 2b. Credentials Delegatus holds that stay with their machine or account

These are secrets, and none of them belongs in a copy-and-move section:
copying them either breaks the source machine or hands out an identity.

| Credential | Where | Why it stays |
|------------|-------|--------------|
| Access key (`LLV_TOKEN`) | env, else `<config>/token` (`bin/viewerGateKey.mjs:58`, `:72`; `bin/tailscale.mjs:433`; checked in `src/proxy.ts:96`) | Opens this machine's board to the network; each machine needs its own. Already shown through the QR (`src/components/AccessQrButton.tsx:86-99`). |
| Viewer control credential (`LLV_VIEWER_CONTROL_TOKEN`) | `src/lib/mcp/controlEndpoint.ts:88`, `:160` | Binds MCP to this Viewer. |
| Host control identity | `scripts/rebuild-http.ts:41-48` | Deploy authority of this host. |
| Web push keys (VAPID) | `<state>/push-keys.json`, `src/lib/push.ts:12`, `:19-84` | Phone subscriptions are bound to this machine's public key. |
| Team sessions and passkeys | `<state>/team/team.sqlite`, `src/lib/team/store.ts:670` | Member identities. |
| Telegram personal session and connector token (`LLV_TELEGRAM_MCP_TOKEN`) | `<state>/telegram/session.json`, `connector-token`, `src/lib/telegram/sessionStore.ts:31-35` | A logged-in Telegram user session; reusing it on two machines risks the account. |
| GitHub App credential | OS keyring, service `delegatus-github-app`, `bin/forge-app-token.mjs:28`, `:94`, `:580` | Already in the at-rest-encrypted keyring; issued per installation. |
| Copilot token | desktop keyring, `src/lib/accounts/copilot.ts:25` | Engine login. |
| Claude provider account token (`ANTHROPIC_AUTH_TOKEN` at launch) | account home, 0600 file, `src/lib/accounts/claude.ts:166-181`, `:204`, `:903-916` | Belongs to an account in the Accounts panel; that panel adds and removes it. Q5. |
| Claude / Codex OAuth logins | account homes; Codex `~/.codex/auth.json` (`transcribeBackend.ts:111`), used by ChatGPT dictation | Refresh tokens rotate: a copy that refreshes on machine B logs machine A out. |

### 2c. Secrets only the environment supplies

`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, AWS and
Google variables are stripped from every managed agent
(`src/lib/agent/cli.ts:207`, `src/lib/accounts/claude.ts:902`);
`GITHUB_TOKEN`/`GH_TOKEN` are removed before App-authenticated `gh` runs
(`src/lib/forge/appWrite.ts:119-120`, `bin/forge-app-token.mjs:409-410`) and
read only by an operator script (`scripts/privacy-github-audit.ts:561`).
Delegatus never uses them as its own keys, so the section does not list them.

### 2d. Non-secret settings beside the keys (environment or file)

Not keys, and listed so the section's scope is explicit:
`LLV_TRANSCRIBE_BACKEND` (`transcribeBackend.ts:97`), `LLV_TTS_BACKEND`
(`ttsBackend.ts:47`), `LLV_TTS_{OPENAI,ELEVENLABS,SONIOX,FISHAUDIO}_{MODEL,VOICE}`
and `LLV_TTS_SONIOX_LANGUAGE` (`ttsBackend.ts:85-131`), `LLV_WHISPER_MODEL`,
`LLV_WHISPER_DEVICE`, `LLV_WHISPER_VENV` (`src/lib/transcribe/local.ts:13-21`),
`LLV_TELEGRAM_PYTHON` (`src/lib/telegram/packaging.ts:81`). Backends and voices
already have choosers in the mic menu and read-aloud settings. See Deferred.

### 2e. Environment keys inside the image

On a Docker install the runtime host copies the predecessor container's
environment into each successor (`src/runtime-host/hostSuccessor.ts:236-262`).
A key set by variable therefore lives in the container definition and is
printed by `docker inspect` to anyone in the docker group. A key set in
Delegatus lives in a 0600 file. The section says which is which (§4 states).

## 3. Storage model options

| Option | What | For | Against |
|--------|------|-----|---------|
| **S1. Keep today's files, add one catalog** (recommended) | A code table `src/lib/keys/catalog.ts`: id, variable, file, validator, «used by», and the existing reader and writer per key. The section, the import and every existing route go through it. | Zero data migration; every reader keeps working; a key typed today stays where it is; the five files are already 0600 and atomic. | Plaintext at rest, as today and as the engines' own credentials. |
| S2. One `<config>/keys.json` | All keys in one 0600 JSON | One file to back up | Every reader changes; a migration with fallbacks; one corrupt write loses all keys. Nothing in R1–R7 needs it. |
| S3. OS keyring (libsecret, as the GitHub App does) | `secret-tool` per key | Encrypted at rest under the login keyring | The Viewer runs in a container without a session bus; headless servers have no keyring; the image path in AGENTS.md would need a keyring bridge. Heavy for R1–R7. |
| S4. Encrypted file with a key file beside it | AES over S1 | — | The decryption key sits next to the ciphertext under the same uid: no protection gained. |

S1 is the design. S3 is listed in Deferred for an install that wants at-rest
encryption later.

The catalog adds one writer that is missing today: Fish Audio's, with the
same atomic 0600 write the other four use (`settings.ts:115-138`,
`transcribeBackend.ts:38-48`).

## 4. The section and its states

The section is called **Ключі** (en **Keys**). The menu row that today reads
**Ключ OpenRouter** becomes **Ключі** with a short state under its name, for
example «5 із 6 задано». The row keeps its place and its `KeyRound` icon.

Each key row shows:

- the provider name and, in muted text, what uses it («Для диктування й
  читання вголос»);
- a **status dot** with a short popover (never a pill):
  - green — «Збережено тут» (`file`);
  - accent indigo (`--color-accent`; the `info` token is teal and too close
    to green) — «Задано змінною OPENROUTER_API_KEY; змінюється там»
    (`env`), with the docker note when the install runs in the image; the
    row also says «· зі змінної» after the masked value or the variable
    name, so the source reads without the popover;
  - hollow grey — «Не задано»;
  - amber — «Не вдалося прочитати» (the reader threw; today's
    `providerKey.failed` case);
- the masked value (`sk-or-v1-••••••••0000` style: a public prefix the
  provider prints on every key, eight bullets, the last four characters);
- actions: eye (reveal/hide), copy, and a ⋯ with «Скопіювати замасковане»
  and «Замінити». An `env` key has eye and copy and no «Замінити»: the
  variable wins, so a file would change nothing (`transcribe/key/route.ts:36-38`
  refuses it today).

**Adding a key** is giving a value to a catalog row that has none: the row's
field opens in place, as `KeyPanel` does today. A free-form «name = value»
key has no reader in Delegatus and `environmentIsolation.ts` would drop it
from every child, so the catalog stays closed (Deferred).

**The places that ask for a key today** (memory's «Ввести ключ»,
`MemoryPage.tsx:208-209`; the setup guide's voice step; the voice companion
dialog) keep their state line and replace their own field with a button that
opens **Ключі** at that row. That is R1's «в одном месте»: one field, one
validator, one writer. Q6.

Staging keeps today's rule: a staging Viewer shares production's files and
refuses writes (`asks-you/key/route.ts:20`); the section shows
`providerKey.staging` and hides «Замінити» and import.

## 5. Reveal and copy contract

R2–R4 need the value in the browser. The contract keeps that to one request
per press:

- `GET /api/keys` answers the catalog: id, variable name, source, masked
  value, «used by». No value. `Cache-Control: no-store`.
- `POST /api/keys/<id>/reveal` answers `{ value }` and nothing else, under
  the gates in §9. POST so no prefetch, link or log of a GET carries it.
- The eye fetches, shows the value in a read-only monospace field for 30 s,
  then masks again; leaving the page or closing the menu masks at once.
  `aria-pressed` on the eye.
- **Copy** fetches the value and writes it to the clipboard without putting
  it on screen. This is the natural reading of «скопировать без» («copy
  without looking»), so the default copy never reveals. Over a plain-http LAN
  origin `navigator.clipboard` is absent and the existing fallback
  (`src/components/feed/CopyButton.tsx:12-38`) uses `execCommand`, which iOS
  allows only inside the tap; the build fetches on `pointerdown` and copies on
  `click`, or uses a promise-valued `ClipboardItem`. A confirmation reads
  «Скопійовано» for 2 s.
- **Copy masked** copies the masked string from the list payload. It needs no
  reveal request. It exists for the second reading of «скопировать без»
  (sharing which key is set in a chat or an issue). Q1.

## 6. Variants

All three use the app's tokens and existing pieces: the menu page and back
row (`HeaderMenu.tsx:157-171`), `MobileMenuSheet`, `CopyButton`, the `Eye`
glyph from `src/components/icons.tsx`, dialogs on `modalLayer`, status dots
with popovers. Text in Ukrainian; the en locale mirrors it. Fixtures use
placeholder values only (`…0000`, `…1111`).

States every variant renders: list with mixed sources (2 here, 1 env, 3 not
set); one key revealed; copy confirmation; ⋯ open; replacing a key (field
typed, invalid value error); env row popover open; the transfer flow
(export, import preview with new / replaces / skipped-because-env rows,
import done); staging; read failure. Each at 1440 and 390 px, light and dark.

### Варіант 1 · «Сторінка в меню»

The existing key page grows into all keys. Settings → **Ключі** opens a menu
page with a back row, exactly as **Ключ OpenRouter** does now.

- **1440 px.** The header menu panel stays 232 px wide, open over the board.
  Six rows of about 40 px: the name over the dot and the masked tail
  (`••••0000`), then eye, copy and ⋯ as 28 px icon buttons; «used by» moves
  into the dot's popover for lack of width. A revealed value opens under its
  row in a monospace field that wraps to three lines (an OpenRouter key is
  about 73 characters, roughly 30 a line at 11 px in 216 px).
  Under the list, a divider and two rows: **Скопіювати всі ключі** and
  **Імпортувати ключі**; import opens a third page with a textarea and the
  preview list. The 360 px height rule of `header-menu.md` holds for the list;
  a revealed key or an open field passes it.
- **390 px.** The phone menu sheet's page: rows 56 px with 44 px targets
  (eye, copy, ⋯ = 132 px), masked tail under the name. Transfer rows at the
  bottom; import is a sheet page with the textarea above the keyboard.
- Least new chrome; the operator finds it where the OpenRouter key is today.
  Cost: the transfer flow is three menu pages deep, and a revealed value
  wraps.

### Варіант 2 · «Діалог ключів»

Settings → **Ключі** opens a dialog, like **Пов’язані інсталяції**
(`src/components/links/LinkedSettingsDialog.tsx:62`) and the voice companion
settings.

- **1440 px.** A 640 px dialog centred over the dimmed board. A table: name
  with «used by» under it, variable name in muted monospace, dot, a
  read-only masked field with the eye inside its right edge, copy, ⋯. A
  revealed value fits on one line. The footer holds **Експортувати…** and
  **Імпортувати…**; each opens a step inside the dialog (choose the format,
  see what goes, copy or download; or paste/open, preview, apply).
- **390 px.** The dialog becomes a full-height sheet with a sticky header
  and footer; rows stack: name and dot on the first line, field with eye and
  copy on the second, ⋯ at the end of the first.
- Room for the variable names (the «environment variables» the operator
  mentions) and a one-line reveal. Cost: one more dialog in the app.

### Варіант 3 · «Задані зверху, перенесення окремо»

Same dialog shell as 2, ordered for the move.

- **1440 px.** Two groups: **Задано** (here and env, with full actions) and
  **Не задано** (each a row with **Додати**, which opens the field in place).
  A banner-free header line «6 ключів · 5 задано» with one primary button
  **Перенести на іншу машину**, which opens a two-tab step: **Звідси**
  (export) and **Сюди** (import), so the operator does both halves from the
  same button on both machines.
- **390 px.** Full sheet; the move button sits in the sticky footer; groups
  collapse to their headers when more than six rows exist.
- Puts R5 first. Cost: «Не задано» splits the list, so a key's position
  changes when it is set.

## 7. Moving keys to another machine

| Option | How | Contains | Transit risk | Build cost |
|--------|-----|----------|--------------|------------|
| **M1. Copy all as env lines** (recommended, with M2 offered) | **Скопіювати всі ключі** writes `NAME=value` lines, one per set key, with a comment header (date, count; no machine names). The other machine's **Імпортувати** takes the same text from a paste. | The catalog keys that have a value, `env` ones included unless the operator unticks them (Q4); the Telegram bot token as `DELEGATUS_TELEGRAM_BOT_TOKEN`. | The clipboard: clipboard managers keep history; phones sync clipboards. | Small: a formatter and a parser over the catalog. |
| M2. Encrypted file | **Експортувати файл** asks nothing and shows a generated passphrase (six groups of four base32 characters) once, with copy; downloads `delegatus-keys-2026-10-15.dlgkeys` sealed with scrypt + AES-256-GCM from `node:crypto`. Import asks for the file and the passphrase. | Same set as M1. | The file can travel over Telegram or email; the passphrase goes by another path. | Medium: a format, a KDF cost bound, a file picker, tests. No dependency. |
| M3. Send to a linked install | Over the paired link of `docs/design/linked-installs.md` | Same set | No clipboard, no file | Large: a new peer endpoint, a confirm on the receiving side; only for linked pairs. Deferred. |
| M4. Per-key copy only | Copy each key, paste on the other side | One key | Clipboard | None beyond §5 |

Import, whatever the source:

1. Parse known names only (`OPENROUTER_API_KEY`, …, `export NAME=value`,
   quoted values); unknown lines are listed as «Невідомі — пропущено» by
   name, and a line with no `NAME=` by its number, never its text. Once
   pasted, the field shows the lines with every value masked to its last
   four characters, with «Вставити інше» to paste again.
2. Preview each key as **Новий**, **Замінить збережений** (with both masked
   tails), **Пропущено: задано змінною на цій машині**, or **Невірний формат**.
3. **Застосувати** writes each through the catalog writer; the Telegram token
   goes through the existing connect (`service.ts:453`), which checks it
   with Telegram and records the bot id. The preview warns: «Бот відповідає
   лише на одній машині. Від’єднайте його на старій.»
4. The pasted text is cleared from the field on apply and on leaving the page.

M1's format doubles as a systemd `EnvironmentFile` or shell `export` source
on a server, so the same text serves a machine that takes keys by variable.

## 8. What each variant shows, by size (summary for the critic)

| | 1440 px | 390 px |
|---|---|---|
| 1 | 232 px menu page over the board; transfer as menu pages | Phone menu sheet page; 44 px targets |
| 2 | 640 px dialog, table with variable names; export/import steps in the dialog | Full-height sheet, two-line rows |
| 3 | 640 px dialog, «Задано» / «Не задано», one «Перенести» button with two tabs | Full-height sheet, move button in the sticky footer |

## 9. Security notes

Common to all variants:

- **Gates on reveal, export and import**: `rejectCrossOrigin`
  (`src/lib/sameOrigin.ts`), `requireOperatorAuthority`
  (`src/lib/agent/operatorAuthority.ts:176`) so an agent that names itself is
  refused, `requireOwner` on a team install (`src/lib/team/http.ts:59`) so
  members see states only, refused in staging for writes, `no-store` on
  every answer, request bodies bounded as `asks-you/key/route.ts:24-37` does.
  The keys routes stay off the peer surface (`src/proxy.ts:11`, `/api/peer`)
  so a linked install can never ask for them.
- **What the gates do not change.** `requireOperatorAuthority` refuses only a
  caller that presents an agent capability. A process of the same user (an
  agent with a shell) can already read the 0600 files and inherits the five
  forwarded variables (`environmentIsolation.ts:4-10`). The reveal route adds
  no capability on the machine itself; it adds one for a browser that passed
  the perimeter (access key or member session), which is why owner-only and
  same-origin matter.
- **Audit**: each reveal, copy, export and import writes one lifecycle event
  with the key id and the action, never the value.
- **Never in**: the list payload (masked only), RSC props, logs, error
  bodies, the board, telemetry, transcripts. `src/app/servedPayloadSecrets.test.ts`
  gains a case that the built `GET /api/keys` holds no catalog value.
- **At rest**: unchanged plaintext 0600 files (S1). Env keys on a Docker
  install are visible to `docker inspect` (§2e); the env popover says so.
- **The bundle carries** only §2a keys. It never carries anything from §2b or
  §2c: access key, control credentials, push keys, team data, Telegram
  personal session, GitHub App key, engine logins, provider account tokens.
- **Clipboard**: a copied key outlives the page. The copy confirmation does not
  nag; the export step says once «Буфер обміну можуть зберігати інші
  програми».

Per variant: 1 has the smallest surface (no new dialog, transfer through the
same page). 2 and 3 render variable names, which are public. 3's move button
makes export one press from the dialog; it gets the same gates. M2's file is
safe to send only with a passphrase sent separately; the step says so.

## 10. Operator questions

**Q1. What does «скопировать без» mean?**
(a) Copy the value without showing it on screen — the default copy button
does that. (b) Copy a masked form (`sk-or-v1-••••0000`) to show which key is
set. (c) Both: copy without showing as the button, masked copy in ⋯.
*Recommended: (c)* — (a) is what the sentence most likely says, and (b) costs
one menu item.

**Q2. Where does the section live?**
Variant 1 (menu page), 2 (dialog, flat table), 3 (dialog, set first, one move
button). *Recommended: Variant 1* — the same place and pattern as today's
OpenRouter key, no new chrome; switch to 2 if the frames show the reveal or
the import too cramped in the 232 px panel.

**Q3. How do keys move to another machine?**
(a) Copy all as env lines + paste import (M1). (b) Encrypted file with a
passphrase (M2). (c) Both. (d) Per-key copy only.
*Recommended: (a)* — smallest build, and the same text configures a server
by variable; (b) is worth it only if keys travel through chats or email.

**Q4. Keys set by variable: reveal, copy and export them too?**
(a) Yes, same gates. (b) Show the state only.
*Recommended: (a)* — the Viewer already reads them, and a move that silently
leaves them behind breaks the target machine.

**Q5. Which keys are in the section?**
(a) The five API keys and the Telegram bot token. (b) The five API keys only.
(c) (a) plus read-only rows for Claude provider accounts linking to Accounts.
*Recommended: (a)* — every key Delegatus itself reads; provider accounts
already have their own panel.

**Q6. The places that ask for a key today (memory, setup guide voice step,
voice companion dialog):**
(a) Replace their field with a button that opens **Ключі** at that key.
(b) Keep their own fields, writing through the same catalog.
*Recommended: (a)* — «вводились в одном месте» is the requirement.

## 11. Validation against the requirement

- R1: one section, every Delegatus key in it (§2a, §4), and the old fields
  point to it (Q6).
- R2–R4: eye, copy without showing, masked copy (§5).
- R5: copy-all and import, or the encrypted file (§7).
- R6: ElevenLabs, Soniox, OpenAI and Fish Audio, today variables or hidden
  fields, become rows; the variable name and source are visible (§4).
- R7: three numbered variants with the frame list in §6, ending in Q1–Q6.

## 12. Deferred — not currently justified

- Free-form keys (any `NAME=value`): no reader would use them and child
  environments drop unknown `*_API_KEY` names.
- Removing a key from Delegatus: not asked; replace covers a wrong key.
- Testing a key against its provider («Перевірити»): network calls and
  provider-specific errors for a check nobody asked for.
- OS keyring storage (S3) and any at-rest encryption.
- Sending keys over a linked install (M3).
- Non-secret environment settings (§2d) in the same section.
- Rotating or expiring keys, per-key usage numbers.
- Engine logins, provider account tokens and every §2b credential.

## 13. Notes for the prototype stage

- Frames go to `$HOME/Pictures/delegatus-review/keys-settings/`, outside the
  repository, with `readings.json` beside them; nothing rendered is committed.
- The prototype is a static page on the real tokens and components, and its
  render script stays out of the repository. Isolated `HOME`, `TMPDIR`, `LLV_STATE_DIR`; Chrome
  with a short `TMPDIR` if the socket path is too long.
- Fences: lane e206b441 owns the tick settings and the composer chip; the
  section touches neither. No open pull request changes the header menu,
  `MemoryPage.tsx`, the key routes or the readers cited here (checked
  2026-10-15).
- Variant numbers print as «Варіант 1», sentence case.

## 14. Prototype (this lane's branch only)

The prototype runs on the product's own header menu, phone menu sheet and
dialog shell, behind a flag, and is never merged:

- `src/components/keys/keysPrototype.ts`: the six catalog rows on
  placeholder values (runs of one digit), the scenes, the import parser and an
  in-page answer for `GET /api/keys` (states and masked values, no value) and
  `POST /api/keys/<id>/reveal` (one value per press).
- `src/components/keys/KeysSection.tsx`: the section in its three layouts.
- `?keysVariant=1|2|3` (or the local flag `llv_keys_prototype`) turns the
  Settings row **Ключ OpenRouter** into **Ключі**; `&keys=staging|member|failed|rowfail`
  picks a scene. Without the flag every surface is as on `main`.
- The frames come from a case in the phone driver,
  `src/components/mobile/issue1671Evidence.browser.test.tsx`
  («keys settings prototype»), which writes each variant's 17 states at
  1440 × 900 and 390 × 844, light and dark, Ukrainian, plus a crop of the
  232 px panel for Варіант 1 on the desktop, and `readings.json` with each
  frame's surface box, overflow, truncated text, controls outside the surface,
  phone targets under 44 px, popover and menu placement, and whether a value
  was on screen (only in `revealed`). The case checks the clipboard after
  every copy: the value for copy, the masked form for copy masked, and the
  three set keys' names for copy-all.

States: `settings`, `list`, `env-popover`, `revealed`, `copied`, `menu`,
`copied-masked`, `replace-invalid`, `add`, `export`, `export-file` (Варіанти 2
and 3; Варіант 1 has the clipboard only), `import-preview`, `import-done`,
`staging`, `member`, `read-failed`, `row-failed`.

What the frames settled that §6 had wrong: the desktop menu panel is 232 px
wide, so Варіант 1 shows the last four characters and keeps «used by» in the
dot's popover, and a revealed OpenRouter key wraps to three lines there.

What the first critic round changed: the dot's popover opens in the row's
flow under the dot's line, because a floating one ran past the 232 px panel
and covered the next row's buttons, or its own row's field in the dialog. The
⋯ menu is right-aligned under its button and as wide as its longest item.
The pasted import text shows masked in the list's small mono, since the
phone's 16 px input floor made the field the largest text on screen. On the
phone an unset row is three short lines, with «Додати» on the name's line.
Варіант 3 lists an unreadable key in its own group «Не читається», and the
file export's button reads «Завантажити файл» over the file name.

What the second critic round changed: the `env` dot uses the accent, and
every variant's `env` row says «· зі змінної» (Варіант 1 after the name in
the 232 px panel and after the masked tail on the phone, Варіанти 2 and 3
after the variable name), so it reads as set by a variable without hovering.
The ⋯ menu opens in the row in every variant, right-aligned under its button
(the panel's at the row's width), so no edge of it lands on the next row's
icons. A member sees «Задано змінною» as the state word in every variant.
The pasted header line wraps instead of ending in an ellipsis. The driver
fails a frame whose menu overlaps another row's control, whose `env` row
does not name a variable, or whose pasted header is cut.

## 15. As built

The operator answered §10 with the recommended options (form answered
2026-10-15): (c) copy without showing plus a masked copy in ⋯, Варіант 1, the
NAME=value lines, keys set by a variable shown, copied and exported under the
same checks, the five API keys and the Telegram bot token, and the three old
fields replaced by a button that opens «Keys» on that key. The build follows
§4–§7 with these differences:

- **Routes.** `GET /api/keys` (states, and masked values for the owner only),
  `POST /api/keys/<id>/reveal` with `purpose` reveal or copy, `PUT
  /api/keys/<id>`, `POST /api/keys/export`, and `POST /api/keys/import`,
  which answers a masked preview for `{ text }` and writes for `{ text,
  confirm }` only the keys whose kind (and, for a replacement, whose replaced
  key) still match what the preview showed. The gate is
  `src/lib/keys/access.ts`: same origin, no spawn capability of any kind, no
  Viewer service, a browser page's own `sec-fetch-site: same-origin`, and the
  owner on a team install.
- **Validation** is looser than the prototype's shapes: every earlier route
  accepted any one-line key, so only the prefixes every key of a provider
  carries are required (`sk-or-` for OpenRouter, `sk-` for OpenAI, BotFather's
  shape for the bot token), with at least 16 printable characters.
- **Audit** is one log line per action with the key id and the action, never
  the value. The lifecycle journal feeds agents' digests, so key actions stay
  out of it.
- **Unknown names** are echoed in the preview only when they look like an
  environment variable (upper case, short words); a key pasted on the left of
  `=` is counted by its line number, like a line without `=`.
- The English short label of a key set by a variable is «from env»: «from a
  variable» did not fit the 232 px panel's name line.
- **Height.** On the desktop the list page is 370 px tall, as in the approved
  frames: six rows, the back row and the two transfer rows, 10 px over the
  header menu's 360 px. A revealed key, an open field or the staging notice
  makes it taller; the drivers bound the list at 380 px and leave the open
  states unbounded.
- The older write routes (`PUT /api/asks-you/key`, `/api/transcribe/key`,
  `/api/voice-companion/key`) stay for clients of an earlier release; no
  surface of this one calls them.
- Frames come from the phone driver's «keys settings» case at 1440, 800 and
  390 px, light and dark, en and uk, over the real routes in a throw-away
  config directory; its readings are `evidence/keys-settings/frames.json`.
