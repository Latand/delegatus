# A new Celestia clone in one button

## The requirement

Operator, by voice in the Delegatus orchestrator conversation, 2026-10-11 ~17:45 Kyiv, verbatim:

> «нужно переделать немножко штуку, создание клонов с [Celestia], вот там, где у нас сейчас идёт через старт... надо... пройти deep link, привязать. А мы можем сделать по-другому... есть deep link специальный, который сразу создаёт бота с тем названием... Можно даже сделать конструктор... загрузить фотку... Сгенерировать фотку, сгенерировать рандомное название... у нас же есть агенты, которые это могут сделать... особенно если это кодекс, то он может генерировать картинки... менеджбот нужно создать, вот там есть менеджбот, по-моему, там есть deep link... Если нет такого... может быть, когда мы уже создали, тогда уже только тогда исправлять. Вот я вот не знаю, это надо исследовать. Но что нужно сделать... когда у нас нет клона, или даже когда есть клоны, чтобы можно было кнопочкой создать нового клона, ввести там, как он называется, всё... чтобы телега подтянула... мы тогда сразу получаем его в [Celestia], его сразу получает через специальный апдейт, и он... у нас это тоже будет видно.»

The same day the operator also decided, in Celestia's channel, how relay clones are answered: «усе до клону з релеєм — в Делегатус, Celestia лише запасна» (relayed by the Celestia seat). The design below follows it.

## Short answer

Yes. Telegram has the mechanism the operator remembered. Since **Bot API 9.6 (3 April 2026)** a bot with
*Bot Management Mode* switched on can send a user the link
`https://t.me/newbot/<manager_bot>/<suggested_username>?name=<suggested_name>`. Telegram opens a
window with the name and the @username filled in (the user can still edit both), creates the bot when
the user confirms, and sends the manager bot a `managed_bot` update. The manager then reads the new
bot's token with `getManagedBotToken` and controls it through the ordinary Bot API.

The current Bot API is **10.3 (24 August 2026)**; nothing after 9.6 changed this flow, and 10.0 added
the managed bot's access settings.

The link carries only a name and a username. It cannot carry a photo, a description or an instruction,
and it carries no request identifier. The photo and the rest are set after creation, through the new
bot's own token (`setMyProfilePhoto`, `setMyDescription`, `setMyShortDescription`, `setMyName`).

Most of the Celestia half already exists. Its backend has been receiving `managed_bot` updates and
provisioning a clone from them since April 2026. It also has a draft and avatar generator (onboarding
drafts) built for this purpose, which no screen calls yet. What is missing is the link itself, a way
for Delegatus to ask for it over the relay, and applying the photo and the routing when the bot
appears. The Delegatus half is a button and a short form in the Celestia card of the relay settings,
plus four calls over the relay pairing it already holds. The new clone appears in Delegatus through
the target list the pairing already refreshes.

## What Telegram allows (read 2026-10-11)

All quotes are from the official pages, fetched raw on 2026-10-11:
<https://core.telegram.org/bots/api-changelog>, <https://core.telegram.org/bots/api>,
<https://core.telegram.org/bots/features#managed-bots>, <https://core.telegram.org/api/links>.

| Fact | Source and exact text |
|---|---|
| Current version | Changelog: «August 24, 2026 — Bot API 10.3» |
| The feature and its version | Changelog, «April 3, 2026 — Bot API 9.6 — Managed Bots»: «Added support for https://t.me/newbot/{manager_bot_username}/{suggested_bot_username}[?name={suggested_bot_name}] links, allowing bots to request the creation of a managed bot via a link.» |
| Who can be a manager | Features: «Choose one of your existing bots or create a new bot via @BotFather. Open the bot's settings in BotFather's MiniApp and enable 'Bot Management Mode'.» API, `User.can_manage_bots`: «True, if other bots can be created to be controlled by the bot. Returned only in getMe.» |
| What the user sees | Features: «When the user opens the link, they will see a window to finish creating their bot, where the bot's @username and display name are pre-filled, but editable.» |
| Link forms | Links: `t.me/newbot/<manager_bot_username>/<suggested_bot_username>?name=<suggested_bot_name>`, `t.me/newbot/<manager_bot_username>?name=<suggested_bot_name>`, `tg://newbot?manager=<manager_bot_username>&username=<suggested_bot_username>&name=<suggested_bot_name>`. «If non-empty, and the passed value does not end in bot, append bot to the value before recommending it to the user.» Both suggestions «Can be empty, in which case the user must choose». |
| The update the manager gets | API, `Update.managed_bot` (`ManagedBotUpdated`): «A new bot was created to be managed by the bot, or token or owner of a managed bot was changed». `ManagedBotUpdated` has `user` («User that created the bot») and `bot` («Token of the bot can be fetched using the method getManagedBotToken»). |
| Token | `getManagedBotToken(user_id)`: «Returns the token as String on success.» `replaceManagedBotToken(user_id)`: «revoke the current token of a managed bot and generate a new one». |
| Who may use the new bot | Bot API 10.0: `getManagedBotAccessSettings` / `setManagedBotAccessSettings(user_id, is_access_restricted, added_user_ids)`: «Pass True if only selected users can access the bot. The bot's owner can always access it.» «up to 10 identifiers». |
| The in-chat alternative | `KeyboardButtonRequestManagedBot {request_id, suggested_name, suggested_username}`: «pressing the button will ask the user to create and share a bot that will be managed by the current bot … Available in private chats only.» The result arrives as the same `managed_bot` update and a `managed_bot_created` service message whose `ManagedBotCreated` holds only `bot`. Mini Apps reach it through `savePreparedKeyboardButton` (button «of the type request_users, request_chat, or request_managed_bot»). |
| Photo after creation | `setMyProfilePhoto(photo: InputProfilePhoto)`: «Changes the profile photo of the bot.» `InputProfilePhotoStatic`: «A static profile photo in the .JPG format … Profile photos can't be reused and can only be uploaded as a new file». `removeMyProfilePhoto` exists too. |
| Name and texts after creation | `setMyName` («0-64 characters»), `setMyDescription` («0-512 characters»), `setMyShortDescription` («0-120 characters»), each per language. |
| Delivery of the update | `allowed_updates`: an empty list receives «all update types except chat_member, message_reaction, and message_reaction_count». Celestia lists `managed_bot` explicitly. |

What the documentation does **not** offer, read the same day:

- No photo, description or start payload in the link. Whatever is not a name or a username is set
  afterwards with the new bot's token.
- No request identifier on the link path. The update says *who* created *which* bot; matching it to
  the request that produced the link is the manager's job. `KeyboardButtonRequestManagedBot` has a
  `request_id`, but `ManagedBotCreated` does not return it, so the button path does not help either.
- No way to check from the Bot API whether a suggested username is free. Telegram's own window asks
  the user for another one if it is taken.
- No documented per-account limit on how many bots a user can create this way. Not verified.

## How it works today

### Celestia (CelestiaCompose, `main` at 59427bf9, read only)

- **The clone wizard in the webapp** (`apps/frontend/celestia-webapp/src/features/clone/create-clone/`)
  is the BotFather path: copy `/newbot`, create the bot in BotFather, paste its token, grant admin
  rights. This is the flow the operator wants replaced.
- **The managed path exists in the backend.** `tgbot/allowed_updates.py` lists `managed_bot`.
  `tgbot/runtime/stream_runner.py` (`_process_managed_bot_update`) hands every `managed_bot` update
  on the main bot to `HandleManagedBotUpdateUseCase`
  (`application/usecase/clones/handle_managed_bot_update.py`). That use case fetches the token,
  sets the default admin rights, registers the clone with `is_managed=True`, activates it, and applies the owner's pending
  onboarding draft (only its `default_prompt`). A token change or re-delivery re-syncs the stored
  credentials. The stage E2E `tests/e2e/telegram_mcp/test_managed_clone_flow.py` posts a synthetic
  `managed_bot` update against a real managed bot, so the stage main bot has Bot Management Mode on.
- **Drafts and avatars exist, with no screen calling them.** `api/controllers/onboarding.py` serves
  `POST /onboarding/generate` (an LLM proposes name, username, prompt and avatar prompt),
  `POST /onboarding/drafts`, `POST /onboarding/drafts/{id}/avatar/generate` (Gemini, then fal, then
  Reve as fallbacks; five per owner per day) and `POST /onboarding/avatar/apply` (downloads the
  candidate and calls `setMyProfilePhoto` with the clone's token). All four authenticate a WebApp
  user. The webapp's `onboarding.api.ts` calls only the showcase and first-contact events.
- **Nothing builds the `t.me/newbot` link.** No code in the backend or the webapp builds it.
- **The avatar cannot be applied after a managed creation.** Provisioning marks the draft `APPLIED`
  (`_apply_draft_if_exists`). `ApplyOnboardingAvatarUseCase.execute` then refuses with
  `OnboardingDraftNotPendingError` for any draft not `PENDING`. The photo has to be applied inside
  provisioning, before the draft is closed.
- **Relay targets are every active clone of the owner.** `infrastructure/database/repo/relay.py`
  `get_targets` selects `CelestiaClone.owner_id == owner_id, status == "active"`. A clone created for
  the paired owner is therefore listed to Delegatus with no other change. It is answered by Celestia's
  own AI (`hosted`) until its `answer_source` is switched to the relay.

### Delegatus (this repository at 0ef6ec49)

- Celestia is the one built-in relay (`src/lib/externalRelay/knownRelays.ts`, with its origin and
  verify host `t.me`).
- Pairing (`src/lib/externalRelay/pairing.ts`) is the «through /start» step the operator described.
  `POST /pairings` returns a code and a `verify_url` on `t.me`. The owner confirms in Telegram, and
  Delegatus confirms the owner and receives a bearer credential.
- The settings surface (`src/components/externalRelay/ExternalRelaySection.tsx`, inside
  `ExternalRelaySettingsDialog`) shows one card per paired relay, with one row per target. It reads
  `/api/external-relay` every 5 s. The server refreshes a relay's targets at most every 30 s while the
  surface reads them (`TARGETS_REFRESH_ON_READ_MS`), and every 5 min in the poll loop.
  With no targets it says «Сервіс ще не показує для вас жодної цілі.» (`externalRelay.noTargets`).
- A target's engine is set automatically only right after the first pairing (`paired()` in
  `ExternalRelaySection`). A target that appears later arrives with no engine and needs a hand.

## The flow

```
Delegatus (relay settings, Celestia card)        Celestia                         Telegram
1 «Створити клона»: name (🎲 random),
  @username derived from it, photo
  (upload / generate / none)
2 POST /clone-requests ─────────────────────────▶ store as the owner's draft,
                                                   bound to this pairing
  ◀──────────────── {request_id, create_url, expires_at}
3 open create_url (t.me/newbot/<main bot>/<username>?name=<name>) ─────────────────▶ window with
                                                                                     name and
                                                                                     @username
                                                                                     filled in
4                                                                     user confirms ─┘
5                                                 ◀───────── managed_bot {user, bot}
                                                   getManagedBotToken, register,
                                                   activate, then from the draft:
                                                   setMyProfilePhoto, instruction,
                                                   answer_source=relay for this
                                                   pairing; request → created
6 GET /clone-requests/{id} (every 2–3 s) ───────▶ {status: created, target_id}
7 refresh targets; the new row appears marked «Новий», answered by this install with the
  default engine; «Відкрити в Telegram» links to @username
```

**Matching the update to the request.** The only thing the update and the request share is the
Telegram user. Celestia keeps one open request per owner (a new one replaces the old). The `managed_bot`
update from that user closes it, whichever username the user finally chose. A creation with no open
request (the user made a second bot from the same link, or opened an old one) is provisioned as today,
with no draft.

**Which Telegram account.** The bot belongs to whoever confirms in Telegram. Celestia lists targets
by owner, so the new clone appears in Delegatus only when that account is the one paired with this
install. The waiting state says which account is expected (the pairing's owner line).

**One clone at a time until it is set up.** Delegatus keeps the created clone's record until the card
has given it the default engine and the route to this install. Until then the card offers no
«Створити клона», and the install refuses a new request with `clone_setup_pending`, so a failed or
delayed setup stays retryable after a reload.

### Which part belongs to whom

| Part | Delegatus | Celestia |
|---|---|---|
| Button, form, random name, username derived from the name | ✓ | |
| Photo upload (convert to JPEG before sending) | ✓ (`sharp` is already a dependency) | |
| Photo generation | depends on question 2 below | its existing generator, if chosen |
| Building the `t.me/newbot` link (needs the main bot's username) | | ✓ |
| Storing the request as a draft bound to the pairing | | ✓ |
| Receiving `managed_bot`, provisioning | | ✓ (exists) |
| Applying photo, instruction, routing at provisioning | | ✓ (new; fixes the `APPLIED` ordering) |
| Showing the new clone, setting its engine | ✓ | target list exists |

## The ask for the Celestia seat

Send as an agent relay to the CelestiaCompose orchestrator once the operator has answered:

1. **Turn on Bot Management Mode for the production main bot** in BotFather's Mini App, and confirm
   `getMe` returns `can_manage_bots: true` there. The stage bot already runs the managed E2E.
2. **Advertise the capability**: add `"clone_create"` to the relay descriptor's `features`. Delegatus
   shows the button only when it is present.
3. **`POST /clone-requests`** on the relay API, authenticated by the pairing credential. Body:
   `{ name: 1–64, username: 5–32 matching ^[A-Za-z][A-Za-z0-9_]*bot$ (case-insensitive), photo:
   { kind: "jpeg", data: base64 } | { kind: "generate", prompt: string } | null }`. Celestia stores it
   as the owner's onboarding draft bound to the pairing, replacing any open one. It answers
   `201 { request_id, create_url, expires_at }` with
   `create_url = https://t.me/newbot/<main bot>/<username>?name=<url-encoded name>`. It answers 429
   past a per-owner daily limit, the same way as the avatar generator.
4. **`GET /clone-requests/{id}`** → `{ status: "pending" | "created" | "expired" | "failed",
   target_id?, username?, reason? }`, and **`DELETE /clone-requests/{id}`** to cancel it.
5. **At provisioning** (`HandleManagedBotUpdateUseCase`, new clone with an open request from that
   owner): set the photo with `setMyProfilePhoto` (uploaded JPEG or the chosen generated candidate)
   *before* the draft is marked `APPLIED`. Set `answer_source = relay` for the requesting pairing with
   fallback `service`, per «усе до клону з релеєм — в Делегатус, Celestia лише запасна». Then mark the
   request `created` with the target id. If the photo fails, keep the clone and report
   `created` with `reason: "photo_failed"`.
6. **Webapp**: offer the same link in place of the `/newbot` + token wizard. That is Celestia's own
   call and not needed for Delegatus.

## Variants (the prototype review)

Published 2026-10-11 as the prototype review «Новий клон Celestia однією кнопкою» (`pr_06a0f6358baadcdd1eac6e3dfedbc785`), three variants and the six questions below.

The frames are held by the published review. Their source (`frames.tsx`, `render.ts` and a
`geometry.json` recording each frame's overflow, cut text, phone tap targets and control overlaps)
stayed in the design lane and is not part of this repository. Each variant is shown with no
clones, with clones, while setting up, waiting for Telegram, and created. Every variant and state
renders at 1440 uk light and 390 uk dark. The no-clone and setup states also render at 1440 en dark
and 390 en light.

1. **У картці Celestia.** The form opens in place inside the Celestia card, below the clone rows:
   name with 🎲, @username, photo (upload, generate, none, four candidates). While Telegram is open,
   a pending row and a waiting note show; the new row then appears marked «Новий». With no clones,
   a dashed block with one primary button takes the place of «Сервіс ще не показує…». No new
   surface; every control is a recipe the card already uses.
2. **Конструктор.** «Створити клона» opens its own dialog in three steps (Вигляд, Telegram, Готово),
   with a Telegram-style preview of the portrait, name and @username, a «Характер» field that becomes
   the clone's first instruction, a sketch of the Telegram window while waiting, and a finish screen.
   This is the most complete builder; it is also a new surface with three screens.
3. **Одна кнопка.** A ready random name sits beside the button («Буде «Нічна Сова» · @nichna_sova_bot»,
   🎲 for another, «Змінити» for a name field). One click opens Telegram. The photo is offered on the
   new clone's row after it exists. This is the fewest steps before Telegram, and the photo needs a
   second action.

## Questions for the operator

Each has the recommended answer first.

1. **Which flow?** — *Variant 1, in the Celestia card* (recommended: no new surface, name and photo
   on one screen, reuses the card's rows) · Variant 2, the builder · Variant 3, one button.
2. **Who generates the photo?** — *Celestia's existing generator* (recommended: already built and
   rate-limited, with three model fallbacks; Delegatus sends a prompt and gets four candidates) · a
   Codex agent on this install (uses the operator's Codex account; image generation by Codex is not
   verified here) · upload only for now.
3. **Who answers a new clone at first?** — *This install, with Celestia as the fallback*
   (recommended, per «усе до клону з релеєм — в Делегатус») · Celestia's hosted AI until switched by
   hand.
4. **A «Характер» field at creation?** — *No; name and photo only, instructions later* (recommended:
   the form stays one screen) · yes, optional, it becomes the clone's first instruction.
5. **With no Celestia connection yet?** — *Connect first, then the create button shows*
   (recommended: pairing proves which Telegram account owns the clones) · one button that pairs and
   then creates.
6. **Send the ask to the Celestia seat now?** — *Yes, as written above* (recommended) · after the
   prototype is chosen.

## Decisions (2026-10-11 ~18:45 Kyiv)

The operator answered every question with the recommended option:

1. **Variant 1, in the Celestia card.**
2. **Photo from Celestia's existing generator** (four candidates, at most five generations a day), with
   upload and «Без фото» kept beside it as in the prototype.
3. **This install answers a new clone from the start**, Celestia as the fallback.
4. **No «Характер» field.** Name and photo only; instructions later.
5. **Connect first**: the block shows only on a paired Celestia card.
6. **The ask was sent** to the Celestia seat the same day, as written above.

## What the Delegatus side builds against

Celestia's endpoints are not live yet. Delegatus builds against the shapes of the ask, dark behind
the descriptor feature, and tests them with a fake relay. The ask left the shape of the generated
candidates to Celestia; until it answers, Delegatus uses the shape Celestia's onboarding generator
already returns (`GenerateAvatarResponse`), reached over the relay:

- **`POST /clone-avatars`** `{ prompt }` → `200 { candidates: [{ storage_key, url }] }` (one to four
  candidates, `url` an `https` image address); 429 past the daily limit.
- The chosen candidate goes into the request as `photo: { kind: "candidate", storage_key }`, beside
  `{ kind: "jpeg", data }` for an upload (converted to JPEG on this install) and `null`.

All three requests carry the pairing credential. The block shows when the paired relay's descriptor
lists `"clone_create"`; the settings surface re-reads the descriptor at most every five minutes while
it is open, so the block appears without a new pairing once Celestia ships the feature.

## Risks

- **Bot Management Mode on production is unverified.** Stage has it; production needs `getMe` on the
  main bot, which this stage could not call (no token, and it is Celestia's bot). Celestia confirms it
  as the first point of the ask.
- **The wrong Telegram account.** If the operator confirms the link in a different account, the
  clone is created for that account and never appears here. The waiting note names the paired owner.
  Delegatus stops waiting when the request expires and offers to open the link again.
- **Old Telegram clients** may not know `t.me/newbot` links. The documentation does not say what
  they show. The waiting note keeps «Відкрити Telegram ще раз» and cancel.
- **Username taken.** Telegram's window asks for another. Celestia matches by owner, so the request
  still closes.
- **Matching by owner alone.** Two requests from the same owner at once would race; one open request
  per owner, the newer one replacing the older, keeps it to «the newest wins».
- **Photo after provisioning.** Today's `APPLIED`/`PENDING` ordering would lose the photo silently;
  the ask moves the photo into provisioning.
- **Telegram limits** on bots per account and on profile photo changes are not documented on the
  pages read. Not verified.

## Deferred — not currently justified

- **Delegatus generating the photo with its own agent**, unless question 2 chooses it: Celestia
  already has a generator with fallbacks and a daily limit; a second one on this side is more
  machinery for the same picture.
- **The `KeyboardButtonRequestManagedBot` path** (a button in the Celestia chat). It needs the user
  in the bot's private chat and returns no request id either; the link works from any surface,
  including the phone.
- **Restricting who may use the new bot** (`setManagedBotAccessSettings`). Clones are public group
  bots today; nothing in the requirement asks to restrict them.
- **Showing the clone's photo on the target row** in Delegatus. It needs a new field in the relay
  target schema. The row keeps its engine mark, and the photo shows in the form and in Telegram.
- **An LLM proposing the name** (Celestia's `/onboarding/generate`). A word-list random name is
  instant and free; the 🎲 button answers «сгенерировать рандомное название».
