# Telegram file confirmation: the owner sign-in loop and computed spreadsheet text

## Requirement

On 2026-11-25 the operator reported, through the operator terminal and this
lane's pipeline task, that the Telegram file confirmation page on a team
install sends the owner back to sign-in without end. An agent had sent a
spreadsheet (a staffing table) to the owner's private chat. The secret
detector refused it as `document_secret`, class `computed_text`, line 1, which
is a false positive. The owner signed in twice by device approval, the owner
member has no linked Telegram account, and the page kept returning to
`/sign-in`. The operator asked for three things:

- (a) The page states exactly what is missing and offers a button into the
  existing "Link Telegram" flow that returns to the same confirmation. No
  silent redirect to `/sign-in`. English and Ukrainian. Regression test.
- (b) A decision, from this brief's recommendation, on whether an owner
  session approved from a trusted device plus a relay pairing to the same
  Telegram id may pass without a Telegram sign-in. If the answer is no, (a)
  ships alone.
- (c) The detector stops flagging an ordinary spreadsheet with formulas or
  computed text, keeps real secrets in spreadsheets detected, and gets a
  regression test.

All references are to `origin/main` at `54ed826d`, read with `git show` and
`git grep`.

## (a) The loop

### Failure path

1. `src/app/api/telegram/bot/confirmation/route.ts:19-25` — `owner()` runs the
   browser perimeter (`companionOperator`), reads the paired destination
   (`ownerReviewDestination().chatId`) and calls `authenticatedOwner`. Any
   failure answers `401 { code: "OPERATOR_REQUIRED" }` with no reason. GET
   (`:26-32`) and POST (`:33-45`) share it.
2. `src/lib/team/actor.ts:53-61` — `authenticatedOwner` requires all three:
   `session.method === "telegram"`, `member.role === "owner"`, and
   `member.telegram.userId === chatId`. The observed owner fails two of them
   permanently: device approval mints method `approval`
   (`src/lib/team/members.ts:498-508`), and the member has no `telegram`.
3. `src/components/telegram/TelegramFileConfirmation.tsx:229` maps every 401
   and 403 to one state, `"owner"`. `:244` does the same after a POST.
   `:249-255` renders `ownerTitle` / `ownerBody` and a **Sign in** link to
   `/sign-in?next=<this page>`.
4. `src/components/team/SignInCard.tsx:157-160` returns to `next` after any
   method, approval included, so the owner lands on step 3 again. Telegram
   sign-in cannot help an owner with no linked account: the bot treats the
   account as unknown and the code turns into a join request
   (`src/lib/team/telegramSignIn.ts:362-373`).
5. Linking Telegram alone does not end the loop either. A link binds
   `member.telegram` (`telegramSignIn.ts:343-360`) and mints no session;
   `completeTelegram` refuses link requests (`:384`). The browser keeps its
   approval session.
6. Solo installs loop with no input at all: `requestSession` returns null
   without a team store (`src/lib/team/sessions.ts:78-82`), and the sign-in
   page sends a solo browser straight back (`SignInCard.tsx:147-149`).

### What to build

**One rule, with its reason.** Add `ownerTelegramGap(req, telegramUserId)`
beside `authenticatedOwner` in `src/lib/team/actor.ts`. It returns null or
the first missing item, in this order, and `authenticatedOwner` becomes
`ownerTelegramGap(...) === null`. The truth table for every caller stays
identical. An exception while reading the team store keeps today's refusal
with no reason.

| `missing` | Condition | Page action |
|---|---|---|
| `team` | no team store, or no active owner (solo) | link to `/team` to set up the team |
| `owner` | the live session's member is not the owner | link to `/sign-in?next=` to sign in as the owner |
| `pairing` | no owner review destination (`telegramUserId` undefined) | text only: pair the owner's Telegram in the relay settings, then ask the agent to send again |
| `telegram_link` | the owner has no linked Telegram | in-page **Link Telegram** |
| `telegram_account` | linked Telegram ≠ paired owner id | in-page **Link Telegram** (a new link replaces the old one) |
| `telegram_session` | session method ≠ `telegram` | in-page **Continue with Telegram** (sign-in) |

**Route.** `owner()` answers `401 { code: "OPERATOR_REQUIRED", missing }`.
An anonymous team browser still gets `401 MEMBER_REQUIRED` from the
perimeter, and capability or service callers still get 403. Only a verified
member session sees `missing`, and the facts it reveals concern the caller's
own install and account.

**Page.** `TelegramFileConfirmation` keeps the existing **Sign in** card for
`MEMBER_REQUIRED` only. For a 401 that carries `missing`, it renders that
state's heading, body and action. Nothing navigates on its own. The page
never sends a browser to `/sign-in` unless the person presses a button that
says so. After a POST, a 401 with `missing` shows the same state.

**In-page Telegram step.** The existing link flow lives inside the member
dialog (`src/components/team/MembersTab.tsx:385-420`, `:510-520`). Extract it
into one shared component in `src/components/team/` that both the member
dialog and the confirmation page use. It takes `purpose: "link" | "sign-in"`
and reuses the existing pieces unchanged:

- `POST /api/team/session/telegram` (`src/app/api/team/session/telegram/route.ts:16-39`);
- polling and actions on `/api/team/session/telegram/[id]`
  (`[id]/route.ts:16-42`);
- `TelegramCodeForm` (`SignInCard.tsx:82-122`);
- for sign-in, the `complete` action as `SignInCard.tsx:263-274` calls it.

The bot link opens in a new tab or the Telegram app, as an anchor with
`target="_blank"` (`SignInCard.tsx:342`). The confirmation page stays in
place and keeps its request proof in memory. When the step reaches `linked`
(link) or `complete` (sign-in), the page fetches the confirmation again. It
then shows either the next missing item or the request itself. A sign-in that
ends in `needs_approval` (some other Telegram account pressed Start) sends
`not-me`, so no join request is left behind. The page then says that this
Telegram account is not linked to the owner. `telegram_unavailable` shows the
existing `team.telegram.unavailable` text.

In the operator's case the page now goes: **Link Telegram**, press Start in
the bot, type the code; then **Continue with Telegram**, press Start, type
the code; then the request appears. Each step happens once per browser. A
Telegram session lasts 30 days idle and 180 days at most
(`src/lib/team/store.ts:46-47`), so later confirmations open directly.

**Text.** New strings go into `fileConfirmationText`
(`src/lib/telegram/bot/fileConfirmationContract.ts:86-88` / `:114-116`). The
buttons reuse `team.telegram.link`, `team.signIn.telegram` and
`team.signIn.openTelegram`.

| `missing` | English | Ukrainian |
|---|---|---|
| `team` | **This Delegatus has no owner yet.** Confirming a file send needs an owner who signs in with Telegram. Set up the team and link Telegram first. Button: *Set up the team* | **У цього Delegatus ще немає власника.** Щоб підтвердити надсилання файлу, потрібен власник, який входить через Telegram. Спершу налаштуйте команду й прив’яжіть Telegram. Кнопка: *Налаштувати команду* |
| `owner` | **Only the owner can confirm this send.** This browser is signed in as another member. Button: *Sign in as the owner* | **Підтвердити це надсилання може лише власник.** Цей браузер увійшов як інший учасник. Кнопка: *Увійти як власник* |
| `pairing` | **Owner reviews in Telegram are not set up.** No Telegram account is paired to receive owner reviews here, so this send cannot be confirmed. Pair the owner's Telegram in the relay settings, then ask the agent to send again. | **Огляди власника в Telegram не налаштовано.** Тут жоден акаунт Telegram не підключено для оглядів власника, тож це надсилання не можна підтвердити. Підключіть Telegram власника в налаштуваннях ретранслятора й попросіть агента надіслати знову. |
| `telegram_link` | **Link your Telegram to confirm this send.** This browser is signed in as the owner, and the owner has no Telegram account linked. Confirming a file send needs the owner's Telegram: the account paired for owner reviews. | **Прив’яжіть Telegram, щоб підтвердити це надсилання.** Цей браузер увійшов як власник, а до власника не прив’язано акаунт Telegram. Для підтвердження потрібен Telegram власника — акаунт, підключений для оглядів власника. |
| `telegram_account` | **Link the Telegram account paired for owner reviews.** The owner's linked Telegram is a different account. Linking the paired one replaces the current link. | **Прив’яжіть акаунт Telegram, підключений для оглядів власника.** До власника зараз прив’язано інший акаунт. Нова прив’язка замінить поточну. |
| `telegram_session` | **Sign in with Telegram to confirm this send.** This browser signed in without Telegram. Confirming a file send needs the owner's Telegram sign-in on this browser. | **Увійдіть через Telegram, щоб підтвердити це надсилання.** Цей браузер увійшов не через Telegram. Для підтвердження власник має увійти через Telegram у цьому браузері. |

Linking or relinking the owner's Telegram already calls `revokeOwnerRuns()`
(`[id]/route.ts:27-30`). This change keeps that behaviour.

### Shared paths

`authenticatedOwner` has five production callers: the confirmation route,
`src/lib/externalRelay/requesterEnrolmentHttp.ts:31`,
`src/lib/externalRelay/trustedRequesterStore.ts:144`,
`src/lib/prototypeReview/decision.ts:253` and `src/lib/voiceTools/http.ts:18`.
Its null-team default lives at `src/lib/team/contract.ts:177,213`. Only the
confirmation route reads the new reason. The other four keep the same
boolean. `src/lib/externalRelay/requesterEnrolment.ts:268` has its own
Telegram-method check, and it stays untouched.

### Regression tests for (a)

- `src/app/api/telegram/bot/confirmation/route.test.ts`. This harness already
  mints a claim-method owner cookie and a Telegram-method cookie (`:42-50`).
  Add one table for GET and POST: an approval session for an unlinked owner
  gives `telegram_link`; owner linked to another id gives `telegram_account`;
  linked and matching with an approval or claim session gives
  `telegram_session`; relay paused or removed gives `pairing`; a non-owner
  member gives `owner`; a Telegram session gives 200. No case sends anything.
  The existing approval test (`:87-115`) keeps passing as written.
- A DOM test for `TelegramFileConfirmation`, with fetch mocked in the
  `*.dom.test.tsx` pattern of `src/components/externalRelay/`. A 401 with
  `telegram_link` renders the heading and **Link Telegram** in English and
  Ukrainian. It has no `/sign-in` anchor and does not change
  `window.location`. Pressing the button posts `{ purpose: "link" }`. Moving
  to `code_sent`, then the code, then `linked` triggers a second GET. That
  GET answers `telegram_session`, which renders **Continue with Telegram**.
  `confirmed`, then `complete`, then a third GET returns the pending view.
- Rendered evidence: add the six states to the existing confirmation case in
  `src/components/conversation/conversationWindow.browser.test.tsx`, at the
  same widths, languages and themes it already covers (390×844 touch and
  1440×900, en and uk, light and dark).

## (b) Approval session plus relay pairing: security boundary

### What each proof establishes

| Proof | Established by | What it proves about the person at this browser |
|---|---|---|
| Telegram sign-in session | The browser types back a 6-digit code that the install's bot sent to Telegram account X's private chat. 10-minute request, single use, five wrong codes void it (`telegramSignIn.ts:44-47`, `:317-399`). The member's linked Telegram is X. | At sign-in time, they held X or were handed X's code (the bot warns against sharing it). |
| Approval session | Any live session of the same member typed this browser's user code and approved it (`members.ts:450-508`, `src/app/api/team/session/approve/route.ts:14-35`). | Someone holding a live session of that member approved it. The record keeps only `method` (`sessions.ts:94-104`), so the approving session's method is unknown. The chain can start at an install claim (`src/app/api/team/claim/route.ts:17-32`), a host recovery link, a handoff, a passkey or a Telegram sign-in. |
| Relay pairing to X (`pairedTelegramOwner`) | An owner-level browser or the local operator started and confirmed a pairing (`src/lib/externalRelay/routeGuard.ts:9-23`, `pairing.ts:82-132`). The relay service attests the owner id X. | Nothing about this browser. It is install configuration, written once. |

The review destination comes from the pairing:
`selectOwnerDestination` returns `chatId = relay.owner.id` of an active
relay at the known relay origin (`src/lib/externalRelay/ownerDestination.ts:15-46`).
`pairedTelegramOwner(chatId)` checks the same store for the same id
(`src/lib/externalRelay/store.ts:223-229`). So "a relay pairing to the same
Telegram id" holds whenever a destination exists. It adds no condition.
The proposal therefore reduces to this: **any live owner session passes
while the owner has no linked Telegram.**

`telegramOwnerActor` (`actor.ts:31-43`) is not a precedent for this. It
attributes a message that arrived through the paired relay from account X.
That message is itself a proof that someone held X. A browser session
carries no such proof.

### Who could confirm a file send

- **Today:** a browser holding a Telegram-method session of the owner, where
  the owner's linked account matches the paired owner. Getting one takes
  control of the paired Telegram account at sign-in time, or a stolen cookie
  from such a session. Someone with any owner session can also re-point the
  pairing: link their own Telegram, pair the relay with it, and sign in with
  it. Each of those steps revokes owner runs and moves where owner reviews
  arrive, so it is visible.
- **With the proposal:** any browser holding any owner session. That covers
  a browser left signed in (up to 180 days), every device ever approved in
  that chain, whoever claimed the install while it was solo, and whoever
  holds a host recovery link. None of them needs the owner's Telegram.

Replay and expiry do not separate the two. Both sessions are bearer cookies
with the same lifetimes, and a stolen cookie works the same way under either
rule. The difference is how the session was obtained. Under today's rule,
only Telegram control yields one. Under the proposal, owner-session control
does, and that set is larger and has no record of its origin.

`docs/design/native-caller-admission.md:23-33` and
`docs/design/telegram-file-confirmation.md:101-105` chose this boundary on
purpose. The person who receives owner reviews in Telegram is the same
person who approves in the browser. A self-claimed owner or a local passkey
does not count.

### Recommendation: keep Telegram sign-in required

Ship (a) alone. Reasons:

1. The pairing condition is always true when a destination exists, so the
   proposal is the "any owner session" rule that both earlier designs
   rejected.
2. "Approved from an already trusted device" cannot be checked: sessions do
   not record which session approved them.
3. A file-only exception would put a second, weaker owner rule beside the
   shared verifier that four other surfaces use.
4. After (a), the cost is two Telegram steps, once per browser.

Answer to the boundary question: a file send is confirmed only by an owner
session created by a Telegram sign-in (method `telegram`) while the owner's
linked Telegram account is the one paired for owner reviews. Linking proves
control of that account. A session records its method and no Telegram id, so
the check reads the owner's current link (`ownerTelegramGap` in
`src/lib/team/actor.ts`).

## (c) `computed_text` on ordinary spreadsheets

### Where it is classified

- `src/lib/telegram/bot/officeDocuments.ts:602-603` sets `requiresConsent`
  when a SpreadsheetML `calcPr` element has `fullCalcOnLoad` set to 1, true or
  on.
- `officeDocuments.ts:346-358` passes that flag to the visitor for each part.
- `src/lib/telegram/bot/documents.ts:565-566` turns it into
  `{ secretClass: "computed_text", line: 1 }`. `:576-578` reports it as
  `document_secret`.

Nothing else sets the class. The trigger is the workbook's recalculation
flag, and that flag comes from library defaults. In the wheels the previous
attempt inspected, openpyxl 3.1.5 defaults `CalcProperties.fullCalcOnLoad`
to true (`openpyxl/workbook/properties.py`). XlsxWriter 3.3.4 sets
`calc_on_load = True` and writes `fullCalcOnLoad="1"` unless the mode is
manual (`xlsxwriter/workbook.py`, `_write_calc_pr`). So almost every workbook
an agent writes in Python is flagged, even with no formula at all. This
explains the observed staffing table and its fixed "line 1". Meanwhile, a
workbook saved by Excel usually lacks the flag, so a secret it builds with a
formula goes unflagged.

The case the flag stands in for is in `src/lib/telegram/bot/service.test.ts:503`.
A secret is split across `A1` and `B1`, and `C1 = CONCAT(A1,B1)` shows it
whole. The scan already reads every stored text: shared strings, inline
strings, cached values, string literals joined per formula (`:623-628`),
number-format literals, comments, names and properties. Each cell is read as
its own line (`officeDocuments.ts:192`). So the only text it misses is text
that a formula joins from cells.

### The narrow change

The whole change is in `officeDocuments.ts`. `documents.ts` stays unchanged.

1. Remove the `fullCalcOnLoad` trigger (`:602-603`). The recalculation flag
   stops counting as evidence of a secret.
2. Read computed text directly. For each worksheet formula, build a
   **formula reading**: walk the formula as written, in order, and append
   each string literal and the stored text of each single-cell reference
   (`A1`, `$A$1`), with no separators, and the text cells of each range
   (`A1:B9`, `A:B`, `1:3`), row by row. A reference may name a sheet of the
   same workbook (`Keys!A1`, `'Q 1'!A1:B2`). Then append each reading as
   its own line to that part's text, which `documentSecret` scans as it does
   today, under the class that matches.
   - Stored text: for `t="s"`, the shared string by index, read from the
     part the workbook's relationships name (rich runs joined, phonetic runs
     left out). For `t="inlineStr"`, the inline text. Otherwise, `<v>`.
   - Shared strings are resolved per package prefix before the sheets are
     read, as Word styles already are (`:350-355`). All members are in
     memory at that point.
   - Sheet names resolve through `xl/workbook.xml` and its relationships per
     package, as shared strings do; each foreign sheet is parsed once. Text
     cells (`s`, `inlineStr`, `str`) count inside a range, so `SUM` over
     numbers reads as nothing. References to other workbooks, 3-D spans,
     defined names, table references and dependents of a shared formula
     (`<f t="shared">` without text) are not read.
   - Bounds: at most 64 references per formula. Total reading characters
     per package must stay within the displayed-reading budget the parser
     already uses (`4 × length + 1 MiB`, `:637`). If the budget runs out,
     set `requiresConsent` and stop reading further formulas. Ranges also
     share a package bound of 20 000 000 visited cells, with the same result. `computed_text`
     then keeps one honest meaning: computed text that could not be inspected
     within the limits.

Effect: `CONCAT(A1,B1)` over the split secret reads as the whole token and is
still refused, with or without the flag. A connection URL whose password sits
in its own cell is refused the same way. `=B2&" "&C2` reads as a name,
`=SUM(B2:B10)` reads as nothing, `=IF(D2>0,"yes","no")` reads as a number
and two words, and none of these are flagged. Every secret stored literally
in a cell, formula, comment, name or property is matched exactly as before.

### Regression tests for (c)

In `service.test.ts`, next to the fixtures at `:493-515`:

- an **ordinary workbook** written the way openpyxl writes one:
  `fullCalcOnLoad="1"`, text in `xl/sharedStrings.xml`, `t="s"` cells,
  `=SUM(...)`, `=B2&" "&C2`, `=IF(...)`, no cached values. It sends with no
  confirmation and no `document_secret`;
- the existing `forced-recalc.xlsx` keeps refusing as `document_secret`;
- the same split secret over **shared-string** cells, without
  `fullCalcOnLoad`, refuses as `document_secret`. This proves that the
  reading resolves shared strings and no longer depends on the flag;
- a literal secret in a shared string still refuses;
- the split secret joined by `CONCAT(A1:B1)`, by `TEXTJOIN("",TRUE,A1:B1)` and
  by `Report!A1&Keys!A1` across two sheets refuses as `document_secret`, with
  `fullCalcOnLoad` and without it.

A focused case in `src/lib/telegram/bot/officeDocuments.test.ts` covers the
budget: a workbook whose formula readings exceed it reports `requiresConsent`.

## Checks for the build lane

The pinned specification governs. Run only the touched test files, one per
invocation, under `flock /var/tmp/llv-heavy-gate.lock timeout 900`, with
isolated `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR`:
`route.test.ts`, the new DOM test, `service.test.ts`,
`officeDocuments.test.ts`, `src/lib/team/contract.test.ts`, and the
conversation-window driver case with `LLV_CONVERSATION_BROWSER_TEST=1`. Full
typecheck stays with CI. The review runs on Claude.

## Deferred — not currently justified

- **Approval sessions that inherit Telegram assurance.** A session approved
  by a Telegram-method session of the same owner could count as Telegram.
  That needs a new session field and a store migration. It would not help the
  observed owner, who has never had a Telegram session.
- **Telegram sessions that outlive a relink.** A Telegram session minted while
  the owner was linked to another account stays valid after the owner links
  the paired account, because a session carries no Telegram id. Binding the
  signing id to the session needs a new session field and a migration.
  `route.test.ts` pins today's behaviour.
- **Link and sign in as one step.** `completeTelegram` could mint a Telegram
  session after a link confirmed from the same member's browser. The proof
  is as strong as a sign-in and saves one Start press. It changes every link
  flow, and the two-step page meets the requirement. Revisit if the second
  step proves painful.
- **Resuming an in-flight Telegram step after a reload.** The step's proof
  lives in page memory. If a phone webview reloads, the page shows the same
  state again and the old request expires in 10 minutes.
- **A deep link from the `pairing` state to the relay settings.** There is no
  stable route for that dialog today. The state names where to go in text.
- **Formula readings through defined names, table references, other
  workbooks, 3-D sheet spans and shared-formula dependents.** Ranges and
  cells of a sheet named in the same workbook are read (text cells only; a
  numeric cell adds nothing to a range).
