# Linking installs: a step-by-step dialog — implementation brief

Status: design brief, 2026-09-29. Read-only design stage; no product code is
changed here. Every code claim was checked in this worktree at `ade4fc0c2`
(`main`, after PR #2325 merged as `6cb4deb60`).

## Originating requirement

Pinned task, 2026-09-29, from a high-priority Inbox card. Operator words
relayed in English by the orchestrator, quoted verbatim:

> Зв'язування інсталяцій: зрозумілий покроковий UX
>
> Operator context, 2026-09-28/29: the operator couldn't link their home
> machine with the stage install. It was unclear which machine does what, and
> the "address unverified" state looked like an error even though it doesn't
> block anything. On 2026-09-29 they asked to go through the Inbox and
> continue with what matters; this is a high-priority Inbox card.
>
> Acceptance:
> 1. The dialog leads with two clear roles: "this machine accepts a
>    connection" and "this machine connects to another". Each has numbered
>    steps that say which side must be reachable from the other.
> 2. "Unverified" reads as a warning with an explanation and an action ("check
>    it from the other machine"), and it never looks like a blocking error.
>    Genuine blockers (no HTTPS, no access key, unsafe proxy) stay clearly
>    blocking.
> 3. The pair code is shown together with the exact address to type on the
>    other machine, with copy buttons.
> 4. When the peer runs a different Delegatus version that matters for
>    linking, the dialog says so.
> 5. Everything that works today keeps working: address, key, self-check,
>    allow linking, connect, shared projects, existing peers. Both locales
>    (uk, en).
> 6. Renders at 390px and at 1440px, uk and en, for each role and state
>    (unverified, verified, code shown, connected), saved to
>    `~/Pictures/delegatus-review/linking-ux/`. Updated DOM tests. The
>    project's own checks pass: tsc, touched test files one per invocation
>    under `flock /var/tmp/llv-heavy-gate.lock`.
>
> Not in scope: any change to the pairing protocol or the self-check logic.

The diagnosis on the same card: the stage install saved a public address
behind Caddy and its self-check said "unverified" (hairpin); #2325 lets such
an address mint a code; the home PC had no public address, no peers, and
nobody had minted a code.

## 0. What this brief decides

One dialog, same entry points. It opens with a two-choice role picker. Each
role shows three numbered steps. The steps reuse every control the dialog has
today, grouped by the role they belong to. Below the steps, both roles see the
same "Connected machines" list (peers and grants) and "Shared projects". The
changes are confined to the client:

- the dialog's layout and copy,
- a severity for each self-check state, read from data the server already
  returns,
- the pair-code panel showing the saved address with copy buttons,
- connect errors and per-peer errors translated where they happen, including
  the version cases.

No route, payload, pairing message or self-check changes.

## 1. Files and components involved

| File | What it holds | Lines |
|---|---|---|
| `src/components/links/LinkedSettingsDialog.tsx` | The whole dialog: state, fetches, every section | 1–211 |
| same | `LinkedSettingsHost`, opens on the window event | 213–221 |
| `src/components/links/LinkConnectForm.tsx` | "Connect to another install" form: address, code, name | 6–18 |
| `src/components/links/mintRefusal.ts` | `MINT_REFUSALS`, compile-time completeness check, refusal sentence | 6–21 |
| `src/components/links/openLinkedSettings.ts` | Event name `delegatus:open-linked-settings` | 1–5 |
| `src/components/links/ShareProjectRow.tsx` | Per-project share switch in project menus (not in this dialog) | 10–42 |
| `src/components/links/LinkedSettingsDialog.dom.test.tsx` | Existing DOM tests (5) | 70–119 |
| `src/components/Viewer.tsx` | Mounts `<LinkedSettingsHost />` | 1754 |
| `src/components/ProjectRail.tsx` | Desktop rail menu row that opens it | 477–478 |
| `src/components/ProjectDashboard.tsx` | Phone menu row that opens it | 2070 |
| `src/components/feed/CopyButton.tsx` | `copyText` with the plain-http LAN fallback | 12–34 |
| `src/lib/i18n/en.ts`, `src/lib/i18n/uk.ts` | `links.*` copy | en 31, 106–189; uk 30, 105–188 |
| `src/lib/i18n/i18n.test.ts` | en/uk key parity | 8–9 |
| `scripts/capture-board-geometry.ts` | The one browser driver for dialogs; `self-update-auto` is the template | 5342–5425, dispatch 5427–5436 |

### 1.1 State sources

| Dialog variable | Source | Server file:line |
|---|---|---|
| `value: State` (`self`, `state`, `entry`, `keyOn`, `tailnetUrl`) | `GET /api/links`, and the answer of every `POST /api/links` | `src/app/api/links/route.ts:13-15, 43-77` → `currentSelf()` `src/lib/links/self.ts:126-134` |
| `value.state` | last saved check code, overridden to `needs-access-key` when the key is off and to `needs-remote-entry` when the entry is not publishable | `self.ts:129-132` |
| `value.entry.localVouches` | **already returned; the dialog's type omits it** (`LinkedSettingsDialog.tsx:16`) | `publicEntry()` `src/lib/links/publicEntry.ts:9-32`, included by `self.ts:128,133` |
| `code`, `codeStatus` | `POST /api/links/codes`, then `GET /api/links/codes` every 3 s | `src/app/api/links/codes/route.ts:9-19`, `mintCode` `src/lib/links/protocol.ts:31-49`, `listCodes` 51–53; poll `LinkedSettingsDialog.tsx:49-73` |
| `mintRefusal` | the error of a refused mint | `LinkedSettingsDialog.tsx:120-135` |
| `peers` | `GET /api/links/peers` → `peerRows()` (`id, label, url, state, error, lastCall`) | `src/app/api/links/peers/route.ts:10-12`, `protocol.ts:138`; `Link.state` is `active \| failing \| revoked`, `src/lib/links/state.ts:19` |
| `grants` | `GET /api/links/grants` → `grantView` (includes `created`, unused by the dialog) | `src/lib/links/state.ts:105-113` |
| `shared` | `GET/PATCH /api/links/shared` | `LinkedSettingsDialog.tsx:75-79, 136-140` |
| `error`, `notice` | one shared `error` for every action; `notice` only for "remove-warning" | `LinkedSettingsDialog.tsx:39-40, 95-117` |

### 1.2 Facts the role split rests on

- **The connecting machine needs no address.** `connectPeer` calls
  `ensureSelf()`, which creates an identity with `publicUrl: null`
  (`src/lib/links/client.ts:77`, `self.ts:34-53`).
- **Only the connecting machine opens connections.** Pairing, info and every
  sync request go from the machine that typed the code to the other one's
  address (`client.ts:84, 88, 102, 189`). The design says it outright: "the
  granting machine (B) never calls out … the home machine connects to the
  server, and the server never needs a route to it"
  (`docs/design/linked-installs.md:1379-1383`).
- **So the accepting machine must be reachable from the connecting one, and
  never the reverse.** In the operator's case the stage accepts, and the home
  PC connects.
- **The connecting machine re-checks the address from outside.** Before it
  pairs, it sends the loopback-Host probes through the accepting machine's
  public address and refuses `peer-open` if one is vouched (`client.ts:82-87`).
  This is the real "check it from the other machine" that acceptance item 2
  asks the copy to name.

## 2. Every state, and what each role sees

### 2.1 Check-state severity

The dialog reads the severity of each check state from data it already has.
Today it draws four states red and everything else grey
(`LinkedSettingsDialog.tsx:173`). That leaves `host-rewritten`, `tls-failure`
and `invalid-address` grey, although `mintCode` refuses every one of them
(`protocol.ts:26, 37`).

| `value.state` | Severity | Blocks a code? | Why (file:line) |
|---|---|---|---|
| `ok` | ok (green) | no | `protocol.ts:26` |
| `unverified`, `entry.localVouches === false` | **warning** (amber) | no | `pairable` admits it, `protocol.ts:26`; redemption too, `protocol.ts:99` |
| `unverified`, `entry.localVouches === true` | blocking (red) | yes | `protocol.ts:26, 37` |
| `needs-access-key` | blocking | yes | `protocol.ts:33`, `self.ts:130` |
| `needs-remote-entry` | blocking | yes | `protocol.ts:35`, `self.ts:131-132` |
| `http-public` | blocking | yes | `protocol.ts:35`, `self.ts:223` |
| `open-to-internet` | blocking, plus a banner above the roles | yes | `protocol.ts:35`; banner per `linked-installs.md:1173-1174` |
| `host-rewritten` | blocking; the box also lists what arrived (below) | yes | `self.ts:256`, `protocol.ts:37` |
| `tls-failure` | blocking | yes | `self.ts:231-233`, `protocol.ts:37` |
| `invalid-address` (a save refusal) | blocking | yes | `self.ts:138`, `protocol.ts:34` |
| `save-conflict`, `key-failed`, `unavailable` | request error (red, `role="alert"`) | none: these are failed requests | `self.ts:159`, `route.ts:64` |
| `null` (no address saved yet) | nothing drawn | yes (`invalid-address` on mint) | `protocol.ts:34` |

Each drawn state carries `data-linked-state={code}` (kept) and a new
`data-linked-severity="ok|warning|blocking|error"`. Blocking and warning never
share a colour: blocking uses `bg-danger-soft text-danger` with the lead
"Blocks linking", and the warning uses `bg-warning-soft text-warning` (the LAN
warning's style, `LinkedSettingsDialog.tsx:170`) with the lead "Not checked
from here". Only request errors take `role="alert"`. A state read on open
keeps `role="status"`, as today.

**What a `host-rewritten` box says (#2516).** The saved check carries
`expected` (the address's host) and `seen` (`host`, `forwardedHost`,
`forwardedProto`, `forwarded`, as the self-check route read them;
`linked-installs.md` §3.1). Under the state sentence the same box draws
`[data-linked-host-seen]`: `links.hostSeen.expected`, a four-row list (Host,
X-Forwarded-Host, X-Forwarded-Proto, Forwarded; `links.hostSeen.absent` for a
header that did not arrive; values in monospace, wrapping anywhere), and the
action: `links.hostSeen.actionForwarded` when X-Forwarded-Host names the
address, `links.hostSeen.action` otherwise. The box gains sentences and no
control. A check saved before this detail existed draws its one sentence.

The "Allow a connection" button's disabled rule stays exactly as it is
(`LinkedSettingsDialog.tsx:185`). A stale `tls-failure` or `host-rewritten` may
already be fixed, and a mint runs a fresh check (`protocol.ts:36`). So the
button stays live, and a refusal is answered beside it, as #2325 made it.

### 2.2 Role

- Two choices in a `role="radiogroup"`: **accept** and **connect**.
- Default, computed once when the first `GET /api/links` answers: **accept** if
  `self.publicUrl` is saved, or `grants` is non-empty, or a code is live.
  Otherwise **connect**. On the stage that opens accept; on the home PC (no
  address, no peers) it opens connect.
- The choice lives in component state only, with no new file or setting.
  Switching roles never changes a server value.
- Both panels stay mounted and the inactive one takes `hidden`, so a
  half-typed connect form survives a switch (`LinkConnectForm.tsx:8-10` holds
  its own state).

### 2.3 States per role

"Accept" and "Connect" are the role panels. "Both" is what sits outside them:
the banner above, and the lists below.

| # | State | Trigger | Accept sees | Connect sees | Both see |
|---|---|---|---|---|---|
| S0 | Loading | `value === null`, no error | step 1 fields disabled, "Loading…" | form enabled (it needs nothing loaded) | — |
| S1 | Unavailable | initial fetch failed, `LinkedSettingsDialog.tsx:91-92` | step 1: request error | form | error line above the roles |
| S2 | No address yet | `self.publicUrl` null | step 1 empty, steps 2–3 greyed: "Save an address first" | normal | — |
| S3 | Key off | `needs-access-key` | step 1: blocking line and the "Turn on the access key" button first | normal (connecting does not need the key; `connectPeer` never reads it) | — |
| S4 | Unverified, not blocking | §2.1 | step 1: amber warning, explanation, "check it from the other machine" with the saved address and a copy button; step 2 enabled | normal | — |
| S5 | Unverified, blocking | §2.1 | step 1: red, proxy target; step 2 enabled, and a mint is refused beside the button | normal | — |
| S6 | Other blocker | §2.1 | step 1: red line naming the fix | normal | `open-to-internet` also draws the banner above the roles |
| S7 | Verified | `ok` | step 1: green "Reachable at this address", checked time | normal | — |
| S8 | Request error | save/key/check failed | step 1: red alert | — | — |
| S9 | Mint refused | `mintRefusal` | step 2: red alert beside the button (kept, `LinkedSettingsDialog.tsx:186`) | — | — |
| S10 | Code shown | `code`, status open | step 3: address + copy, code + copy, expiry, wrong-attempt count, "Cancel code" | — | — |
| S11 | Connected (accept) | poll sees `used`, `LinkedSettingsDialog.tsx:61-63`, refresh adds a grant | step 3 turns green: "Connected: {name} can now reach this install" (`name` = label of the grant with the largest `created`) | — | new row in "Connected machines" |
| S12 | Code expired or burned | `now >= expiresAt` / `burned` | step 3: existing sentence, step 2 button offers a new code | — | — |
| S13 | Code cancelled | DELETE ok | step 3 back to greyed | — | — |
| S14 | Connecting | `busy` during POST peers | — | submit disabled | — |
| S15 | Connect failed | POST peers 409 `{error}` | — | step 2: the error under the form (§4.3), never in the self-check line | — |
| S16 | Connected (connect) | POST peers 200 `{peer}`, `peers/route.ts:22-24` | — | step 3 turns green: "Connected to {peer.label}" | new row in "Connected machines" |
| S17 | Peer failing / revoked | `peer.state`, `peer.error` | — | — | the row shows the translated error (§4.4) and the version sentence for `malformed` / `not-delegatus` |
| S18 | Someone connected here | `grants` non-empty | — | — | grant rows with counts and "Revoke" |
| S19 | Owner-required / staging | any POST answers 403/409 with those codes | refusal where the action was taken | same | — |

Today S15 is broken in two ways, and both are fixed by giving each source its
own error variable:

- `invalid-address` and `http-public` from a connect attempt are in the
  `shown` list (`LinkedSettingsDialog.tsx:142`). So they render as **this**
  install's check state, in the self-check line.
- Every other connect error renders at the top of the dialog
  (`LinkedSettingsDialog.tsx:174`), far from the form.

The split: `selfError` for `act`, `connectError` for the connect call, and
`linkError` for peer, grant and share actions.

## 3. Layout

### 3.1 Desktop, 1440 × 900

The dialog keeps its centred card with `max-w-[640px]` and `max-h-[90vh]`, and
only the body scrolls (`LinkedSettingsDialog.tsx:159-165`). Body padding stays
`sm:px-6`, so the content column is 592 px.

```
┌ Linked installs ─────────────────────────────────────────── [×] ┐
│ Two installs link once. One accepts the connection and must be   │
│ reachable at an HTTPS address. The other connects to it and     │
│ needs no address of its own.                                     │
│ ┌ ◉ This machine accepts ──────┐ ┌ ○ This machine connects ─────┐│
│ │ The other machine reaches    │ │ Pick this on a machine        ││
│ │ this one at its address …    │ │ without a public address …    ││
│ └──────────────────────────────┘ └───────────────────────────────┘│
│ ① Give this machine an address the other machine can open        │
│    Point your proxy at 127.0.0.1:8898 and keep the Host header.  │
│    Machine name  [ stage                                  ]      │
│    Public address[ https://delegatus.example.com          ]      │
│    ┌ ⚠ Not checked from here ─────────────────────────────────┐  │
│    │ This server could not open its own address. …            │  │
│    │ Check it from the other machine: open                    │  │
│    │ https://delegatus.example.com [Copy] in a browser there… │  │
│    └──────────────────────────────────────────────────────────┘  │
│    Checked 29.09, 12:41   [Save address] [Check this address]    │
│ ② Make a pairing code                                             │
│    A code works once, for 10 minutes.   [Allow a connection]     │
│ ③ Enter these on the other machine                                │
│    ┌──────────────────────────────────────────────────────────┐  │
│    │ Address  https://delegatus.example.com           [Copy]  │  │
│    │ Code     R4TZ7M-K7QM9-XTD2P                      [Copy]  │  │
│    │ Expires at 12:51 · No wrong attempts       [Cancel code] │  │
│    └──────────────────────────────────────────────────────────┘  │
│ ──────────────────────────────────────────────────────────────── │
│ Connected machines                                                │
│  home-pc connects to this machine · 3 today · 41 in 7 days [Revoke]│
│ ──────────────────────────────────────────────────────────────── │
│ Shared projects …  (unchanged)                                    │
└───────────────────────────────────────────────────────────────────┘
```

- Role cards: `grid grid-cols-1 gap-3 sm:grid-cols-2`, each a `button
  role="radio" aria-checked`, `min-h-11`, with `border-accent bg-accent/5`
  when chosen. The title is `text-body font-semibold`, the hint `text-ui
  text-muted`.
- Steps: an `<ol>`. Each `<li>` holds a 24 px numbered circle, a title
  (`text-body font-semibold`) and its body, indented to the title's column
  (`pl-9`). A step that cannot act yet is greyed (`text-muted`), stays in
  place and says what it waits for. Nothing is hidden.
- Step 3 panel: `grid grid-cols-[auto_minmax(0,1fr)_auto] items-center
  gap-x-3 gap-y-2`. The label is muted. The value is `font-mono break-all
  select-all`, and the code is also `text-title font-bold tracking-wide`. The
  copy button is a visible labelled button (§3.3). Keep `data-pair-code` on
  the panel, and put `data-pair-address` and `data-pair-code-value` on the
  values.
- The connect role's steps are the same shape. Step 2 wraps
  `LinkConnectForm` without its outer frame and heading: the step title
  replaces `links.connect` as the heading, and the submit button keeps
  `links.connect`.

### 3.2 Phone, 390 × 844

The dialog is already a full-screen sheet below `sm` (`p-0`, `h-full w-full`,
no radius: `LinkedSettingsDialog.tsx:159-160`), with a 56 px header and a
44 px close button (`:161-163`). Body padding is `px-4`, so the content column
is 358 px.

- Role cards stack (`grid-cols-1`). Both cards and the start of step 1 must
  be visible without scrolling at 844 px: intro ≤ 3 lines, each card ≤ 88 px.
- Step indent drops to `pl-8`.
- The step 3 grid keeps three columns. The value column is `minmax(0,1fr)` and
  breaks anywhere, so a long address wraps inside the panel instead of
  widening the dialog. The copy buttons are 44 px tall on a coarse pointer.
- The action rows already wrap (`flex flex-wrap gap-2`,
  `LinkedSettingsDialog.tsx:177`). Every button keeps `min-h-11`.
- Inputs stay full-width `h-11` (`:168-169`, `LinkConnectForm.tsx:13-15`).

Numbers the render must measure (§6.2): dialog `scrollWidth − clientWidth ≤ 1`
at both widths; every button ≥ 44 px tall at 390; both copy buttons fully
inside the dialog's rect; the address and code values not clipped
(`scrollWidth ≤ clientWidth`); both role radios in the viewport on open at
390 × 844.

### 3.3 Copy buttons

Reuse `copyText` from `src/components/feed/CopyButton.tsx:12-34`. It has the
hidden-textarea fallback that a plain-http LAN origin needs, which is a case
this dialog explicitly supports (`LinkedSettingsDialog.tsx:25-31`). Do not
reuse the `CopyButton` component: it is an icon-only ghost built for feed rows
(`CopyButton.tsx:48-50, 78`). Here, a labelled `min-h-11` bordered button that
reads "Copy" and flips to "Copied" for 1.4 s makes the two-machine hand-off
obvious. Its `aria-label` names the object ("Copy address" / "Copy code").

## 4. Copy, en and uk

These keys are new or changed. Every key not listed keeps its text. The
parity test (`i18n.test.ts:8-9`) requires each key in both files.

### 4.1 Frame and roles

| Key | en | uk |
|---|---|---|
| `links.intro` (changed) | Two installs link once. One accepts the connection and must be reachable at an HTTPS address. The other connects to it and needs no address of its own. | Дві інсталяції пов’язуються один раз. Одна приймає підключення, і до неї має бути доступ за HTTPS-адресою. Друга підключається до неї, і власна адреса їй не потрібна. |
| `links.role.label` | What does this machine do? | Що робить ця машина? |
| `links.role.accept` | This machine accepts a connection | Ця машина приймає підключення |
| `links.role.acceptHint` | The other machine reaches this one at its address. Pick this on the machine with an HTTPS address, such as a server. | Інша машина відкриває цю за її адресою. Виберіть це на машині з HTTPS-адресою, наприклад на сервері. |
| `links.role.connect` | This machine connects to another | Ця машина підключається до іншої |
| `links.role.connectHint` | This machine reaches the other one. Pick this on a machine without a public address, such as a home computer. | Ця машина відкриває іншу. Виберіть це на машині без публічної адреси, наприклад на домашньому комп’ютері. |

### 4.2 Accept steps

| Key | en | uk |
|---|---|---|
| `links.accept.step1` | Give this machine an address the other machine can open | Дайте цій машині адресу, яку відкриє інша машина |
| `links.accept.step1Body` | The other machine must be able to reach this address. | Інша машина має діставатися до цієї адреси. |
| `links.accept.step2` | Make a pairing code | Створіть код підключення |
| `links.accept.step2Body` | A code works once, for 10 minutes. | Код діє один раз, 10 хвилин. |
| `links.accept.step2Waiting` | Save an address first. | Спершу збережіть адресу. |
| `links.accept.step3` | Enter these on the other machine | Введіть це на іншій машині |
| `links.accept.step3Body` | There, choose “This machine connects to another”. | Там виберіть «Ця машина підключається до іншої». |
| `links.accept.step3Waiting` | The address and code appear here. | Адреса й код з’являться тут. |
| `links.codeAddress` | Address | Адреса |
| `links.codeLabel` | Code | Код |
| `links.copy` | Copy | Копіювати |
| `links.copied` | Copied | Скопійовано |
| `links.copyAddress` | Copy address | Копіювати адресу |
| `links.copyCode` | Copy code | Копіювати код |
| `links.connectedHere` | Connected: {name} can now reach this install. Choose what to share below. | Підключено: {name} тепер має доступ до цієї інсталяції. Нижче виберіть, чим поділитися. |
| `links.codeUsed` (changed; shown only when no new grant is found) | This code has been used. If the other machine did not connect, make a new one. | Цей код уже використано. Якщо інша машина не підключилася, створіть новий. |

`links.codePrompt` (`en.ts:146`, `uk.ts:145`) is replaced by `step3` and
`step3Body`. Remove it from both files.

### 4.3 Self-check lines (step 1)

| Key | en | uk |
|---|---|---|
| `links.severity.blocking` | Blocks linking | Блокує підключення |
| `links.severity.warning` | Not checked from here | Звідси не перевірено |
| `links.state.unverified` (changed) | This server could not open its own address. That is common behind a router or proxy and does not block linking. | Сервер не зміг відкрити власну адресу. Так часто буває за роутером чи проксі, і це не заважає підключенню. |
| `links.checkFromOther` | Check it from the other machine: open {address} in a browser there. If Delegatus opens, the address works. Connecting checks it again from outside. | Перевірте з іншої машини: відкрийте там {address} у браузері. Якщо відкриється Delegatus, адреса працює. Під час підключення її ще раз перевірять ззовні. |
| `links.state.unverifiedBlocking` | This install trusts requests from this machine, so an unchecked proxy could let anyone in. Codes stay off until the check passes: point the proxy at 127.0.0.1:{port} and check again. | Ця інсталяція довіряє запитам із цієї машини, тож неперевірений проксі може впустити будь-кого. Коди недоступні, доки перевірка не пройде: спрямуйте проксі на 127.0.0.1:{port} і перевірте знову. |

The other `links.state.*` sentences (`en.ts:119-130`, `uk.ts:118-129`) keep
their text. The blocking ones gain the "Blocks linking" lead through
`links.severity.blocking`. `links.mint.unverified` (`en.ts:141`) keeps its
text: after #2325 a mint refuses `unverified` only when the local entry
vouches (`protocol.ts:26`), which is exactly the case it describes.

### 4.4 Connect steps and connect errors

| Key | en | uk |
|---|---|---|
| `links.connectStep.step1` | On the other machine, make a code | На іншій машині створіть код |
| `links.connectStep.step1Body` | Open Linked installs there and choose “This machine accepts a connection”. That machine must be reachable from this one at an HTTPS address. | Відкрийте там «Пов’язані інсталяції» й виберіть «Ця машина приймає підключення». Ця машина має бути доступна звідси за HTTPS-адресою. |
| `links.connectStep.step2` | Enter its address and code here | Введіть тут її адресу й код |
| `links.connectStep.step2Body` | This machine needs no address of its own. It opens the connection, and both directions sync over it. | Власна адреса цій машині не потрібна. Вона відкриває з’єднання, і обидва напрямки синхронізуються через нього. |
| `links.connectStep.step3` | Connected | Підключено |
| `links.connectedThere` | Connected to {name}. Choose what to share below. | Підключено до {name}. Нижче виберіть, чим поділитися. |
| `links.error.unreachable` (changed) | Could not open that address from this machine. It must open from here: try it in this machine’s browser. | Не вдалося відкрити цю адресу з цієї машини. Вона має відкриватися звідси: спробуйте її в браузері цієї машини. |
| `links.error.version` (changed) | That install runs an older Delegatus without linked boards. Update Delegatus there, then make a new code. | Та інсталяція працює на старішій версії Delegatus без спільних дошок. Оновіть там Delegatus і створіть новий код. |
| `links.error.notDelegatus` | That address answers without the Delegatus linking API. Check the address, or update Delegatus there. | Ця адреса відповідає без API зв’язування Delegatus. Перевірте адресу або оновіть там Delegatus. |
| `links.error.peerHttp` | That address is on the internet and starts with http://. Enter its https:// address. | Ця адреса в інтернеті й починається з http://. Вкажіть її https://-адресу. |
| `links.error.peerAddress` | Enter the other install’s address with no path, query or credentials. | Вкажіть адресу іншої інсталяції без шляху, параметрів чи облікових даних. |
| `links.error.other` | Could not connect ({reason}). | Не вдалося підключитися ({reason}). |

The existing `links.error.*` keys (`invalidCode`, `peerOpen`, `alreadyLinked`,
`codeSpent`, `rateLimited`, `revoked`, `storeChanged`, `grantCleanupNeeded`,
`unauthorized`) keep their text. Today `not-delegatus` and `version` share one
sentence (`LinkedSettingsDialog.tsx:147`); they split. An unknown code uses
`links.error.other` and is never swallowed into "The server could not answer"
(which `LinkedSettingsDialog.tsx:155` does today).

### 4.5 Connected machines and peer-row errors

| Key | en | uk |
|---|---|---|
| `links.connectedMachines` | Connected machines | Підключені машини |
| `links.connectedMachinesEmpty` | No machines are linked yet. | Ще жодної пов’язаної машини. |
| `links.peerRow` | This machine connects to {name} | Ця машина підключається до {name} |
| `links.grantRow` | {name} connects to this machine | {name} підключається до цієї машини |
| `links.peerError.unreachable` | Could not reach {name} at its address. | Не вдалося зв’язатися з {name} за її адресою. |
| `links.peerError.version` | {name} sent an answer this install could not read. The two probably run different Delegatus versions: update the older one. | {name} надіслала відповідь, яку ця інсталяція не змогла прочитати. Імовірно, інсталяції працюють на різних версіях Delegatus: оновіть старішу. |
| `links.peerError.clock` | The clocks here and on {name} disagree. Set the time on both machines. | Годинники тут і на {name} розходяться. Налаштуйте час на обох машинах. |
| `links.peerError.quota` | {name} reached today’s limit of task changes from this install. Sync continues tomorrow. | {name} досягла денного ліміту змін задач від цієї інсталяції. Синхронізація продовжиться завтра. |
| `links.peerError.other` | The last sync failed ({reason}). | Остання синхронізація не вдалася ({reason}). |

`revoked` keeps `links.error.revoked`. Sources of the codes:
`client.ts:59, 201-205` (`malformed`, `quota`, `clock`), `client.ts:195`
(`revoked`), `client.ts:303` (catch-all into `failing`), and
`DAILY_ROW_BUDGET = 5_000` rows a day (`taskApply.ts:25, 94`). Today the row
prints the raw code in red (`LinkedSettingsDialog.tsx:192`).

## 5. Version differences (acceptance item 4)

What the running code can detect without touching the pairing protocol:

| Signal | When | Meaning | Where it shows |
|---|---|---|---|
| `version` | connect | the peer's `/api/peer/v1/info` lacks `v: 1` or `feeds.boards: 1`, i.e. it predates linked boards (#2287) (`client.ts:104-105`; answered by `src/app/api/peer/v1/[...path]/route.ts:66`) | connect step 2, `links.error.version` |
| `not-delegatus` | connect | the answer is not JSON or lacks the pair fields (`client.ts:63, 89, 92, 108`) | connect step 2, `links.error.notDelegatus` |
| `malformed` / `not-delegatus` on a peer row | sync | the peer's sync reply has a shape this build does not read (`client.ts:203-205`) | peer row, `links.peerError.version` |

The peer protocol carries no release version: `info` answers `version: 1`, a
protocol number (`[...path]/route.ts:66`). Showing "the other machine runs
1.6.0" would need a new field on a `/api/peer/v1/*` answer, which is the
pairing protocol and out of scope. It is in the Deferred section.

## 6. Tests and renders

### 6.1 DOM tests — `src/components/links/LinkedSettingsDialog.dom.test.tsx`

Extend `serve()` (`:39-53`) so each test can set the `/api/links` view
(including `entry.localVouches`), the codes list, peers, grants and the
answer to `POST /api/links/peers`. Stub `navigator.clipboard.writeText` on the
happy-dom window.

The five existing tests stay, unchanged in intent. Their fixture has a saved
address, so the accept role is the default and `links.allow` is found by text
(`:63-68`).

New tests:

1. **Default role.** A saved `publicUrl` → accept radio `aria-checked="true"`.
   No address, no grants, no peers → connect. Clicking the other radio swaps
   which panel is not `hidden`, and a value typed into the connect form
   survives two switches.
2. **Unverified is a warning.** `unverified` with `localVouches: false` →
   `[data-linked-state="unverified"]` has `data-linked-severity="warning"` and
   `role="status"`, and contains the saved address and
   `links.checkFromOther`. The dialog has no `role="alert"` element, and
   "Allow a connection" is enabled.
3. **Unverified can block.** The same with `localVouches: true` →
   `data-linked-severity="blocking"`, text `links.state.unverifiedBlocking`.
4. **Blockers stay blocking.** Each of `needs-access-key`,
   `needs-remote-entry`, `http-public`, `open-to-internet`, `host-rewritten`,
   `tls-failure` → `data-linked-severity="blocking"`, and `ok` → `"ok"`.
   `open-to-internet` also draws the banner above the role picker.
5. **Code with its address.** A minted code → `[data-pair-address]` equals the
   saved `publicUrl`, `[data-pair-code-value]` equals the code. The "Copy
   address" and "Copy code" buttons write exactly those strings.
6. **Connected, accepting side.** The codes poll answers `used: true` and the
   refresh adds a grant → `[data-linked-connected]` contains that grant's
   label, and the grant row reads `links.grantRow`.
7. **Connected, connecting side.** `POST /api/links/peers` 200 `{peer}` →
   `links.connectedThere` with `peer.label`, and a new `[data-linked-peer]`
   row.
8. **Connect errors stay with the form.** For `version`, `not-delegatus`,
   `http-public`, `invalid-address`, `unreachable` and an unknown
   `something-new`: the sentence renders inside the connect step. No
   `[data-linked-state]` appears for `http-public` or `invalid-address`, and
   the unknown code is named in the text.
9. **Peer-row errors are sentences.** A peer with `state: "failing"` and
   `error: "malformed"` → `links.peerError.version` with its label. An unknown
   code → `links.peerError.other` naming it, and the raw code never stands
   alone.
10. **What worked still works.** Save posts `{action:"save", publicUrl,
    label}`. Check posts `{action:"check"}`. "Turn on the access key" posts
    `{action:"key"}`. "Sync now", "Remove", "Revoke", "Cancel code", the
    share-all checkbox and a project checkbox each call the same URL and
    method as today (`LinkedSettingsDialog.tsx:136, 178-180, 187, 193, 195,
    200-202`).

Also run `src/lib/i18n/i18n.test.ts` (key parity).

Commands, one file per invocation. Never sweep a directory (AGENTS.md, "Never
run this repo's suites against the operator's live state"):

```
flock /var/tmp/llv-heavy-gate.lock bun test src/components/links/LinkedSettingsDialog.dom.test.tsx
flock /var/tmp/llv-heavy-gate.lock bun test src/lib/i18n/i18n.test.ts
flock /var/tmp/llv-heavy-gate.lock bunx tsc --noEmit > "$TMPDIR/tsc.log" 2>&1; echo "tsc exit $?"
```

### 6.2 Renders — a `linking` case in `scripts/capture-board-geometry.ts`

Add the case to the existing driver; do not write a new script (AGENTS.md,
"Rendered evidence"). Model it on `selfUpdateAutoMain`
(`capture-board-geometry.ts:5342-5425`):

- Serve every `/api/links*` route with `page.route(...).fulfill` fixtures, so
  nothing pairs, mints or saves anywhere.
- Open the dialog by dispatching `delegatus:open-linked-settings`
  (`openLinkedSettings.ts:1`) until `[data-linked-settings]` exists.
- Choose the role by clicking its radio.
- Take the locale from `PUT /api/operator/settings`, as that case does
  (`:5367-5368`).
- Wire it into the dispatch at `:5427-5436` as `BOARD_CAPTURE_CASE=linking`.
- Copy frames to `LINKING_EVIDENCE_DIR`, the way `SELF_UPDATE_AUTO_EVIDENCE_DIR`
  works (`:5344, 5407-5409`). Run it with
  `LINKING_EVIDENCE_DIR=$HOME/Pictures/delegatus-review/linking-ux`.

Frames, each at 1440 × 900 and 390 × 844, in en and uk (11 × 4 = 44 PNGs,
named `{width}-{lang}-{frame}.png`):

| Frame | Role | Fixture |
|---|---|---|
| `accept-unverified` | accept | saved address, `unverified`, `localVouches: false` |
| `accept-verified` | accept | `ok` |
| `accept-blocked` | accept | `tls-failure` (a genuine blocker) |
| `accept-host-rewritten` | accept | `host-rewritten` with `expected` and `seen`: Host is the upstream, X-Forwarded-Host names the address (#2516) |
| `accept-host-rewritten-long` | accept | the same with a 200-character `Forwarded` and no header naming the address |
| `accept-code` | accept | the frame above with `ok`, after a mint, code open |
| `accept-connected` | accept | poll `used`, one new grant |
| `connect-start` | connect | no address, no peers |
| `connect-version` | connect | POST peers answers `version` |
| `connect-connected` | connect | POST peers 200, one active peer |
| `peers-version-mismatch` | connect | one peer `failing` with `malformed`, one grant |

Assertions recorded in `linking.json` and failing the run:

- dialog horizontal overflow ≤ 1 px;
- every button ≥ 44 px tall at 390;
- copy buttons and "Allow a connection" inside the dialog rect;
- `[data-pair-address]` and `[data-pair-code-value]` not clipped;
- both role radios in the viewport on open at 390 × 844;
- the frame's text holds its locale's `links.title`;
- `accept-unverified` has no `[data-linked-severity="blocking"]`, and
  `accept-blocked` has one;
- the two `accept-host-rewritten` frames list four headers inside the box,
  none clipped or past its edge, with the expected Host, the received Host
  and the action in the frame's language and no control in the box; every
  other frame draws no header list.

Build and run from an export of the lane's commit under `$TMPDIR`, with an
isolated config root (AGENTS.md, "Only a declared owner resolves the
operator's state directory"). Put `BOARD_CAPTURE_COMMIT` in the record.

## 7. What must not change

- **Routes and payloads:**
  - `GET/POST /api/links` with actions `key`, `check`, `save`
    (`route.ts:43-77`);
  - `GET/POST/DELETE /api/links/codes` (`codes/route.ts:9-28`);
  - `POST /api/links/peers {url, code, name}` (`peers/route.ts:13-28`);
  - `POST/DELETE /api/links/peers/[id]`;
  - `PATCH /api/links/shared`;
  - `DELETE /api/links/grants?id=`.
- **The pairing protocol and the self-check:** `src/lib/links/self.ts:218-260`,
  `protocol.ts:26-110`, `client.ts:73-118`, `src/app/api/peer/v1/**`. Out of
  scope.
- **The mint refusal contract:** `MINT_REFUSALS` and its compile-time check
  (`mintRefusal.ts:6-13`), the refusal beside the button with
  `data-linked-mint-refusal` and `role="alert"`, and the re-read of
  `/api/links` after a refusal (`LinkedSettingsDialog.tsx:125-129`).
- **The code lifecycle:** poll every 3 s, 1 s tick, stop when finished,
  refresh once on `used` (`LinkedSettingsDialog.tsx:49-73`); cancel by id
  prefix (`:187`); the 10-minute, single-use code (`protocol.ts:45`).
- **The "Allow a connection" disabled rule** (`LinkedSettingsDialog.tsx:185`).
- **The address helpers:** the LAN http warning (`:25-31, 170`), "use this
  page" and "use Tailscale" (`:171-172`), the proxy target line (`:167`), the
  checked-at line (`:176`), and the "Turn on the access key" button only
  while it is off (`:178`).
- **The lists:** peer rows with "Sync now" and "Remove", the remove-warning
  notice (`:112, 175`), grant rows with counts and "Revoke", and the whole
  Shared projects section (`:197-206`), with the same rules for which
  checkboxes are enabled.
- **Entry points and shell:** `LinkedSettingsHost` and its event, the rail and
  phone menu rows (`ProjectRail.tsx:477`, `ProjectDashboard.tsx:2070`), the
  `Z.modal` layer, backdrop-click close, and the phone full-screen sheet
  (`LinkedSettingsDialog.tsx:159-163`).
- **Test hooks:** `data-linked-settings`, `data-linked-state`,
  `data-linked-mint-refusal`, `data-pair-code`, `data-code-state`,
  `data-linked-peer`, `data-shared-project`, `data-share-state`,
  `data-linked-http-warning`.
- **`ShareProjectRow`** in the project menus is untouched.

## 8. Options considered

| Option | Verdict | Why |
|---|---|---|
| **A. Role picker + numbered steps in the one dialog, shared lists below** | chosen | Answers item 1 directly. Every existing control keeps working in place. One component, one entry point. |
| B. A wizard with Next/Back | rejected | Hides Save/Check and the peer lists behind navigation. More state, and a returning operator who only wants "Sync now" has to click through it. |
| C. Two dialogs, one per role | rejected | Two menu rows and duplicated lists; the operator still has to know which to open, which was the original confusion. |
| Persist the role choice | rejected | The default derived from the saved address, grants and code already picks correctly for both machines in the incident; a stored choice adds a file and a stale-state case. |
| Show the peer's release version | deferred | Needs a field on `/api/peer/v1/info`, the pairing protocol (§5). |

No ADR: every choice here is a client layout choice and easy to reverse.

## 9. Deferred — not currently justified

- **The peer's release version** on its row. It needs a pairing-protocol field
  (§5), and the item 4 cases that matter are already detectable.
- **A "this peer does not send agent summaries" hint** for a peer older than
  the agent feed (#2305). The capability lives only in memory
  (`client.ts:24, 242`), and tasks still sync without it, so linking works.
- **Naming this machine from the connect role.** The other side lists it
  under `self.label`, which is the hostname by default (`self.ts:41`,
  `client.ts:88`), and that is enough to tell machines apart.
- **A countdown ("expires in 9:41")** in place of the clock time. The
  existing "Expires at {time}" is correct, and a countdown adds a re-render
  every second for no decision.
- **Auto-detecting the role from the network** (for example, probing whether
  this machine is publicly reachable). The derived default is enough, and a
  probe is a self-check change.

## 10. Validation against the requirement

| Item | Where this brief meets it |
|---|---|
| 1. Two roles leading, numbered steps saying who must reach whom | §2.2, §3.1, copy §4.1, `links.accept.step1Body`, `links.connectStep.step1Body`, `step2Body` |
| 2. Unverified = warning with explanation and action; blockers stay blocking | §2.1 table, `links.state.unverified`, `links.checkFromOther`, severity attribute, tests 2–4 |
| 3. Code with the exact address, copy buttons | §3.1 step 3, §3.3, test 5 |
| 4. Version differences named | §5, `links.error.version`, `links.error.notDelegatus`, `links.peerError.version`, tests 8–9 |
| 5. Everything keeps working, uk and en | §7, test 10, parity test |
| 6. Renders at 390/1440, uk/en, each role and state; DOM tests; tsc | §6.2 frames, §6.1 tests and commands |
| Not in scope: protocol, self-check | §7, §9 |

## Notes

- `entry.localVouches` is already in the `GET /api/links` answer
  (`self.ts:128, 133` via `publicEntry.ts:9`), but no route test pins it.
  Test 3 depends on it through a fixture. If the lane wants that field
  guarded, one assertion in `src/app/api/links/route.test.ts` does it.
- This brief was checked against the prior work on #2325 (transcripts of the
  2026-09-29 lanes that fixed the hairpin check). The mint-refusal sentences,
  the placeholder test and the `pairable` rule it describes are the ones cited
  above.
