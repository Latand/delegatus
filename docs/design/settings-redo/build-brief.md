# Settings redo: build brief

Base `8d74de3b5`, read 2026-11-04. Open pull requests read the same day.

**Requirement (paraphrased; the operator's words stay in the private requirements file the task names).**
The operator asked on 2026-10-26 to redo the worst Codex-built frontend, and on 2026-10-27 asked that their own
earlier design requests drive the work. The seat chose variant 3, one Settings window (round `pr_6ff8e18a`,
2026-11-04), which the operator can amend. Build it on real components and real data. Read the private file
first: where it and the prototype differ, the file wins.

**Prototype.** Local branch `pipeline/continue-preserved-settings-prototypes-i-bdf39dff`, head `3d4e85c3b`, under
`docs/design/settings-redo/prototype/`. The frames are gitignored and live in that lane's worktree. Copy its row
shapes and class recipes. Leave out `fitWholeRows`, `holdSheetHeight` and the variant badge.

## 1. Where the real product differs from the frames

Each row was checked in code. The right-hand column is what to build.

| Prototype draws | Real code | Build |
|---|---|---|
| Group «reads and posts as» a clone | `cloneChatView` (`telegram/bot/clone.ts:21`) only says the clone may post, and `/api/telegram/bot` has no reading signal | «posts as Nova, a Celestia clone» |
| Clone recognised on sight | `TelegramChatBot` has no clone marker; `username: null` is the only hint | Additive read field `clone?: { relay: string }` from `route.relay.name` in `cloneChatView` and `contracts.ts` |
| Clone as an option in «Posts as» | `assignBot` refuses anything but a connected bot (`service.ts:483`); clones apply only while nothing is assigned (`multiBot.ts:172`) | No clone option. «Automatic» covers it, and the page says who posts |
| «Add another bot» with no field | Keys holds one Telegram key (`keys/KeysSection.tsx`, `KeyId`); `add_bot` takes a token per sending bot | The main bot's token only in Keys. «Add another bot» opens a page with the existing `TokenForm` calling `addBot`. The token goes in once and is never stored in the UI. This is the one field left on the Telegram surface; a Keys slot per sending bot is deferred |
| Tool key row «Opens Keys» | Tool secrets use their own store and need destinations (`action: "secrets"`) | The row opens a tool sub-page with today's password and destination fields. The operator's Keys list never included tool secrets |
| «Add a tool» with a paste path | `/api/voice-tools` has no propose action; only the agent tool `voice_tools` proposes | A plain row saying to ask the voice or an agent. No chevron, no form |
| Cap row with chevron | Inline field that commits on blur | Row opens a `cap` sub-page: field, usage, reserved, last call, incomplete and cap-reached lines |
| Bot «since 12:04» | The payload has no connected time | Use `lastUpdateAt` / `lastCheckedAt` wording |
| Section «Checks» | The check settings live per pipeline; the menu has no such row | Omit it. Add «Linked» (`links.title`), a real row the prototype dropped |
| No row for `timerTelegram`, `uncertainSession`, `held` | All three are live behaviour | Keep them (§3) |

`held` matters for the choice control. An API choice held without a key draws Codex as selected, and pressing the
selected radio today sends the decision to stay on Codex. A `Select` fires nothing on the same value, so `held` gets
a short line and a «Stay on Codex V3» button under the row.

## 2. Window and menu

New folder `src/components/settings/`:

| File | Holds |
|---|---|
| `SettingsWindow.tsx` | Always-mounted host. Desktop: 820 px dialog on `useModalLayer` at `Z.modal`, top 32 px, foot 36 px, section list 208 px, fixed header and ×. Phone (`useIsMobile`): `MobileSheet` with `name="settings"`, `full`, `pinned` back row. Portal on open, so it paints above an open onboarding dialog |
| `openSettings.ts` | `openSettings(section, sub?)` over one window event |
| `settingsRows.tsx` | Switch, choice, chevron, dot, text, actions and Details rows, plus `Literal`, on `SettingSwitch`, `Select`, `MobileSheetSection` and the phone choice face |
| `StatusDot.tsx` | §4 |
| `PrivacySection.tsx`, `TelegramSection.tsx`, `VoiceSection.tsx` | The three surfaces (§3) |

Sections come from `HEADER_LAYOUTS` settings items plus a new `telegram` item. Each row keeps the handler it has today.

| Section | Hosted how |
|---|---|
| General | Desktop `language`, `push`; phone `sound`, `awake`, `stop` |
| Memory | `MemoryPanel` (only with a project), `MemorySourceRow`, under `MemoryReadingProvider`; state word beside the heading |
| Keys | `KeysMenuPage`, with `KeysImportPage` and `OpenAiFeaturePage` as sub-pages; state word beside the heading |
| Roles and workers | `mapping` opener row, `WorkerLimitSettingsRow` |
| Dictation, Linked, Chat relay | Close the window, call the existing opener |
| Privacy, Telegram, Voice | Native |

Changes to existing files:

- `headerMenu/HeaderMenu.tsx`: `[data-rail-menu-settings]` and the phone `settings` row open the window. The menu's
  `settings`, `memory`, `keys`, `keysImport` and `service` views go; help, stop and rules stay.
- `headerMenu/headerMenuModel.ts`: `telegram` item; update the comments and `headerHome`.
- `keys/openKeys.ts`: the host answers `onOpenKeys` by opening Keys on that key. Callers stay unchanged: `VoiceStep`,
  `MicButton`, `MemoryPage`, `OpenAiServices`.
- `ProjectRail.tsx:632` and `Viewer.tsx:834`: remove the open-the-menu reaction to Keys.
- `Viewer.tsx:2074,2078`: mount the host; the telemetry host keeps only its notice.
- `TelegramConnect.tsx:406`: `<TelegramBotSection>` becomes one row with a status dot opening Telegram. The personal
  account and daily report stay in that panel, unchanged.
- `lib/i18n/en.ts`, `uk.ts`: new short strings. Existing long copy moves into Details, with nothing dropped.
- Docs: `docs/guide/concepts.md`, `getting-started.md`, `security-and-privacy.md`, `swarm-pack-pass.md`, `telegram.md`,
  `voice.md`, `mcp.md`, `docs/design/header-menu.md` (the menu path changes to Settings → Privacy, and so on).

Openers to keep working: `openTelemetrySettings` and the event `delegatus:open-settings`, `openVoiceCompanionSettings`
(companion notice, #3636 passes it), the notice's button, `openKeys`, the rail footer's Telegram row.

## 3. Surfaces: rows to data

Sections read only while shown: `useTelegramBot(open)`, `useVoiceCompanionSettings(open)`, and the memory and tools
reads, so a closed window polls nothing. No bordered box inside a surface. That drops the borders on `ChatRow`-style
items, `ServerRow`, call memory rows, the backend radio group and the uncontained warning. Controls keep theirs.

**Privacy** (`telemetry/TelemetrySettings.tsx`, `SubscriptionApiSetting.tsx`; `/api/telemetry`, `/api/subscription-api-consent`)

- Switch rows: ping (`enabled`, disabled with the `telemetry.locked` line when `locked`), direct Anthropic requests
  (consent), swarm rules (`swarmRules`). The swarm hint names the anonymous counts and their lack of text.
- «What leaves this computer»: one sentence.
- Details: `telemetryNotice`, the variables, endpoints, models, the new-install default and the no-counts-in-this-release line.

**Telegram** (`TelegramBot.tsx` keeps `ChatRow`, `AddChatForm`, `DocumentRootsForm`, `TokenForm`, `ERROR_KEYS` for
onboarding and seat reports; `TelegramBotSection` moves out; `ProjectReportsOverview.tsx`; `hooks/useTelegramBot.ts`)

- Bot: `status.bot`, `receiving` to dot and word; sending bots from `status.bots`. Bot page: «Bot token» row with
  `openKeys("telegram")`, refresh, `ConfirmingAction` remove, sending bots' remove and rejected state, revoke hint.
  `token_rejected` shows the key row with an amber dot in place of today's form.
- No bot and no clone: the token row reads «Not set» and opens Keys. Clone-only (`connected: false` with chats) lists
  the groups, says no token is stored and offers the same row.
- Chats: active and `inactive` from today's `isActive`. The list row shows a dot, title, type and sender line, and a
  short word. The chat page has the post switch, alias with `suggestChatAlias` / `validChatAlias` (share today's
  adoption logic with `ChatRow`; do not copy it), «Posts as» only with two or more posting bots, per-bot state, test
  post, and last post and reports lines. A refused delivery stays visible on the page, naming the bot and the reason.
- Reports: `ProjectLine` keeps its write, name and link paths and its public-group warning, on the app `Select`.
- Folders page: `DocumentRootsForm` behaviour, rows per root. Details: privacy mode, limits, token note.

**Voice** (`voiceCompanion/VoiceCompanionSetting.tsx`, `CallMemorySetting.tsx`, `VoiceDevicesSetting.tsx`, `VoiceToolsSetting.tsx`)

- `enabled` switch. While on: backend `Select` (no radio group), `held` line, `uncertainSession` release.
- Codex V3: last call and plan windows; no key, cap, dollar or spend text anywhere on the page or in its Details.
- API: key row (`keySource`: file, environment, missing) with `openKeys("openai")`, then the cap row.
- Devices keep their hints and permission button. `timerTelegram` keeps its switch and hint.
- Call memory: switch, count row (`retained`), list page, `forget`, `forgetAll`, pending, failed and private lines.
- Tools: one row per server sorted by `ORDER`, with dot, state word and `capability`. The tool page keeps every action,
  with the safe answer the one filled button, «Run once without the sandbox» in the warning colour, and Approve filled
  only once a dry run passed. Ask switch; tool list with a native filter above six tools; command, env, entry, recipient
  and dry-run code in Details.
- The voice window's glass stays where it is. These surfaces get no glass.

## 4. Status dot and popover

`StatusDot` replaces the prototype's inline `DotNote`. A 7 px dot in a button with a 24 px hit area (44 px on the
phone, reaching into the row's padding). A mouse opens it on hover, focus or click; a tap toggles it.

- Portal to `document.body` at `Z.popover`, which outranks `Z.modal` and `Z.sheet`. Take placement and `useDismiss`
  from `team/WorkspaceSwitch.tsx`, with a passive role and no focus move.
- Text is at most two short lines. Never a pill. It covers no words of another row, and of its own row a line whole or
  not at all, so no fragment of a word stands beside it. It opens between the label and the state word at 240 px at
  most, else over the row's muted line at the row's width, else under or above the row, and stays inside the viewport.
  Dot and label stay visible, on an opaque surface.
- A row with a chevron is a `<button>`, so the dot goes beside it. **No nested interactive:** render the row as a
  `<div>` holding the dot button and the row button as siblings.
- Escape closes the popover alone; the next Escape closes the window. A tap on it does not close the sheet.
- The row keeps its short muted word, so states differ in words as well as colour.

Used for: bot, sending bots, chats, key rows, tool servers, the rail footer's bot row.

## 5. Carried findings, each with a measured check

| Finding | Cause | Fix | Check |
|---|---|---|---|
| Foot under an open Details is 7–10 px | `pb-1` plus `pb-2` | `pb-4` on the rows container | Scrolled to end: last text range to scroller bottom ≥ 16 px, every surface and sub-page |
| 6 px switch/select edge at 390 | `SettingSwitch size="sheet"` centres a 36 px track in a 48 px hit area | `-mr-1.5` on the sheet's switch row; leave `SettingSwitch` as it is | Track right = select right = chevron right, ±1 px |
| Value breaks in a sha256 and a folder path | `[overflow-wrap:anywhere]` on values | Remove it from every value. `Literal` stays whole and breaks only after `/` or `:`. A token wider than the column shows a middle-elided form, the whole value in `title` and on copy | Real long path, 64-hex hash and long NAME=value: no break inside a word or at `=`, and no value on a line apart from its name |
| Phone tool page half blank | Full-height sheet with a short page | Keep full height so the title never moves; on the phone the actions block takes `mt-auto` at the sheet's foot | Frame |
| Non-rest frames only in two combinations | Driver subset | §7: every state in all four | Frame count |

Also: no row cut by the scroller on the first screen or at the end of scroll. A small effect sets the scroller's
`max-height` to the last whole row and draws the hairline while more follows.

## 6. Optimistic or waiting

| Shows at once, rolls back on failure with a local error | Waits, and why |
|---|---|
| Ping, swarm, notice dismissal (already) | `connect`, `add_bot`, add chat, test post, refresh: Telegram answers |
| Consent: **change** to optimistic; on failure re-read it as today, since a lost answer can follow a durable write | Keys Telegram token: Telegram checks it |
| Voice `enabled`, `backend`, cap, `callMemory`, `timerTelegram` (already); stop disabling on `busy` | Remove bot, forget call, forget all: irreversible |
| Device choice (local) | `releaseUncertainSession`: the server decides what is left |
| Chat switch, alias, roots, report select (already) | Dry run, approve, reject, disable, remove: the server judges the digest |
| `assignBot`: **change** to `drawn`, a local store write | Report by pasted link: needs Telegram |
| Tool `ask`, tool list (already) | |

## 7. States to render

Every state at 1440 × 900 and 390 × 844, in en and uk, light and dark, with real data shapes and non-default values.
Desktop layout also at 900 × 800. Each frame's defining element stays on the first screen or is scrolled whole.

| Surface | States |
|---|---|
| Window | Section list (phone); landing from each opener; back from a sub-page; opener rows handing off; Keys on a key; Keys from the onboarding voice step |
| Privacy | Rest; swarm on; `locked`; consent read failed; each switch refused and rolled back; Details open at end; notice leading in |
| Telegram | No bot, no clone; clone-only; rest with two bots and chats ok / clone / refused / off; popover on bot, refused chat, clone; bot page; `token_rejected`; `webhook_elsewhere`; sending bot rejected; nine bots; add-bot page; chat page ok and refused; «Posts as»; alias with no suggestion; add by id plus test post; inactive fold; reports with warning, stored refused chat, name needed, link error; folders default and custom with a long path; every Details open at end |
| Voice | Off; Codex with plan; Codex with no call; API key file, environment, missing; cap page usage, reserved, reached, incomplete, refused; `held`; `uncertainSession`; devices permission, denied, missing, speakers unsupported; timer on; memory empty, pending, failed, private, list; tools empty, load error, sign-in; tool pending, containment failed, passed, enabled with over six tools and a filter, changed, rejected, secret needed; popover on key and tool; Details open at end |

## 8. Evidence and tests

Evidence goes through existing drivers only; add cases, name no file after an issue.

- `kanbanBoard.browser.test.tsx` over `issue1695Evidence.fixture.tsx` for desktop, `issue1671Evidence.browser.test.tsx`
  for the phone, each with one `describe` for this work. Real components, stubbed fetches only. Isolated state as the
  project notes require. Each frame is read before it is cited.
- Assert with measurements: acceptance 2 text absence with Codex selected; the three §5 numbers; dot and popover
  inside the viewport; no bordered box in a surface's flow beyond controls; no nested interactive; 44 px targets at 390.

Update these by path; they assert today's shape. Keep behaviour checks.

- `telemetry/*.dom.test.tsx`, `voiceCompanionProduct.dom.test.tsx`, `VoiceToolsSetting.dom.test.tsx`,
  `VoiceDevicesSetting.dom.test.tsx`, `TelegramBot.dom.test.tsx`, `TelegramBot.render.test.tsx`,
  `HeaderMenu.dom.test.tsx`, `ProjectRail.header.dom.test.tsx`, `OpenAiServices.dom.test.tsx:397`.
- `kanbanBoard.browser.test.tsx:2049,2097-2110,2191,8678` read `<input>` state and the notice text in the open dialog.
- `issue1671Evidence.browser.test.tsx:489,1091,12599`.
- `capture-board-geometry.ts:1421,1595,7685,7725,7809-7830`.

Keep these selectors where the row now lives, so the drivers need fewer edits: `data-telemetry-settings`,
`data-telemetry-notice` (#3636 reads it), `data-swarm-setting`, `data-subscription-api`, `data-voice-companion-settings`,
`data-voice-companion-setting`, `data-voice-backend`, `data-voice-companion-open-keys`, `data-call-memory`,
`data-voice-tools`, `data-voice-tool-*`, `data-rail-menu-settings`, `data-rail-menu-keys`, `data-rail-menu-memory`,
`data-header-menu-page`.

Required checks: typecheck, privacy-publication, privacy-tracker-audit, runtime-gate, pre-push.

## 9. Do not touch

- Routes and stored settings: `/api/telemetry`, `/api/subscription-api-consent`, `/api/telegram/bot`, `/api/keys`,
  `/api/voice-companion/*`, `/api/voice-tools`, `/api/projects/settings`. The one data edit is the additive clone field.
- Consent defaults (off on new installs, this install keeps its value) and the environment opt-outs.
- `TokenForm`, `ChatRow`, `AddChatForm` in `onboarding/TelegramReportsStep.tsx` and `orchestrator/SeatReports.tsx`.
- `TelegramPanel`'s personal account, QR login and daily report.
- `KeysSection.tsx` and `OpenAiServices.tsx` behaviour; `MemoryPage`; `SettingSwitch` and `Select` recipes.
- Seat chrome, turbo, the tick panel, the attention toast and the voice companion window; all out of this task.
- No public-destination default changes. Report selection keeps its warning and stays opt-in per project.

## 10. Open lanes on the same files

Read 2026-11-04 from all 18 open pull requests. The other twelve touch none of these paths.

| PR | Overlap | Handling |
|---|---|---|
| #3636 voice reconnect | `VoiceCompanionHost.tsx`, `hostSurfaces.ts`, `voiceCompanionProduct.dom.test.tsx`, both drivers and fixtures | Its diff passes `openVoiceCompanionSettings` and reads `[data-telemetry-notice]`: keep both. No overlap in the settings files. Add driver cases at a new `describe`. |
| #3612 spend credits | `i18n/en.ts`, `uk.ts`, `issue1695Evidence.fixture.tsx`, `kanbanBoard.browser.test.tsx` | Additive strings and a new `describe`, so merge conflicts only |
| #3585 Telegram office documents | `telegram/bot/contracts.ts`, `docs/guide/telegram.md` | The clone field is additive beside it; recheck after it merges |
| #3491 OpenAI key services | Its diff is docs and a prototype case in `conversationWindow.browser.test.tsx`; its build target is `OpenAiServices.tsx`, which this lane hosts unchanged | A later build of it lands in the Keys section |
| #3396 pipeline-from-conversation prototype | `conversationWindow.browser.test.tsx` only | This lane does not touch that driver |
| #2926 agent signal namespaces | `docs/guide/getting-started.md` | Rebase the one line |

Merge the base before publication and re-check these lists.

## Deferred — not currently justified

- A Keys slot per sending bot and per tool secret: changes the `KeyId` contract and its import path.
- Pasting a server address to add a tool: no endpoint exists. Asking the voice or an agent is the quick path today.
- Reading a group through a clone in this surface: the bot payload carries no such signal.
- A clone as an assignable «Posts as» sender: `assignBot` refuses it.
- Moving the personal Telegram account or daily report into the window: no request.
- A settings section for pipeline checks: they stay per pipeline.
