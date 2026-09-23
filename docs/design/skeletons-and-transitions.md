# Skeletons and state transitions on phone and desktop (#2071)

## Originating requirement

Source: GitHub issue #2071, opened by the operator on 2026-09-23. Quoted
verbatim:

> ## Outcome
>
> Loading, empty, error and transition states on phone and desktop look
> deliberate and move smoothly. The operator opens the app on a phone and sees
> content take shape (header with the real project name, the cards that are
> coming), not a column of identical dark placeholder bars under a raw project
> key. Moving between states and screens (board to conversation and back,
> project switch, panel open and close, reconnect after a deploy) does not
> flash, jump or blank.
>
> ## Observed (2026-09-23, phone, dark theme)
>
> - The phone board shows six identical grey skeleton cards and nothing else
>   for a noticeable time.
> - The header shows the raw project key (`repo-<hash>…`) while loading,
>   although the display name is known (`projectDisplayNames`).
> - The operator asked to refresh the skeletons and improve the transitions
>   between states on both mobile and desktop.
>
> ## Requirements
>
> - Inventory first: every loading, empty, error, stale/reconnecting and
>   transition state on phone and desktop (board, task and pipeline cards,
>   conversation feed, orchestrator panel and dock, setup guide, account panel,
>   sheets and dialogs), with screenshots of each as it is today.
> - Skeletons match the shape of what replaces them (cards, rows, header) and
>   never show a raw key or id; the header uses the cached or known display
>   name.
> - Show cached content first where it exists (last board, last conversation
>   tail) and revalidate behind it, instead of a skeleton.
> - Transitions: no layout shift when data lands, no blank frame between
>   screens, short motion that respects `prefers-reduced-motion`, and a visible
>   but quiet reconnecting state when the server restarts during a deploy.
> - Follow `docs/design/viewer-design-system.md`; en and uk.
> - Measure: time to first meaningful paint on the phone board before and
>   after, and layout shift when the board lands.

The pinned stage specification adds three rules. Keep the board's traffic
budget: no new polling, and no bigger `/api/files` payload. Measure on a
production build. The header never shows a raw project key or id.

## Prior work

`search_transcripts`, scoped to the project and then unscoped, found no earlier
design for skeletons or state transitions. One review of the kanban prototype
(2026-09-11) noted that the kanban had no loading skeleton, no
`/api/files` failure banner and no prefs-409 notice. The closest precedent is
in the code: #1821 already persists the tails of the eight most recently viewed
conversations to `localStorage` (`src/hooks/logTailStore.ts`) and paints them
before any request. This design reuses that store unchanged and copies its
rules (bounded, credential-aware, verified on restore) for the board snapshot.

## What current main does (evidence)

Build: production (`next build --webpack`) of main at `6c62bc749`, served by
`next start` under Bun 1.4.0. It ran against the seeded synthetic home from
`scripts/capture-mobile-v2.ts` (one invented project, `atlas`, with 30
conversations) under an isolated config root on a free port. Frames are in
`/var/tmp/skeletons/before/` (local only, not committed). Phone is 390×844 at
DPR 2, desktop is 1440×900, both in the dark scheme, in en and in uk where the
text differs.

| file | what it shows |
| --- | --- |
| `phone-01-server-html-before-hydration.png` | The first paint on a phone is the **desktop** layout: the rail on the left, a 30 px sliver of the overview on the right, and "No projects yet" with a create button. |
| `phone-02-project-loading-files-held-{en,uk}.png` | The operator's screenshot, reproduced: the title reads `dir-<hash>…` and six identical 3-bar cards fill the board. |
| `phone-03-project-settled-{en,uk}.png` | What replaces it: an "Orchestrator" label and a 56 px seat card, then "Working 30" with 56 px single-row cards, then the dock. Nothing in it resembles the skeleton. |
| `phone-04-overview-loading-files-held-{en,uk}.png` | The overview claims "No projects yet" / "Проєктів поки нема" while `/api/files` is in flight. |
| `phone-05-project-board-state-held.png` | Files have landed, the board arrangement has not: the name is right and the skeleton is still the generic one. |
| `phone-06-files-failing.png` | The raw key sits above the failure notice. |
| `phone-07-seat-status-held.png` | The seat card shows a "reading" chip in the same geometry. This one is fine. |
| `phone-08-conversation-tail-held.png` | A never-opened conversation: the bar and composer are real, and the feed is the word "Loading…" at 14vh. |
| `phone-12/13/14-server-*.png` | The server is unreachable for 12 s, then 24 s, then recovers. Nothing on the board says so, and the seat card flips to a warning chip reading "unreadable". |
| `desk-01-server-html-before-hydration.png` | The desktop first paint is also the overview with "No projects yet" plus a spinning rail. |
| `desk-02-project-loading-files-held-{en,uk}.png` | The header shows the raw key and "nothing is running right now" (a false statement while loading), above a 4-across grid of generic cards. The settled board is a tall seat plus four kanban columns. |
| `desk-08-conversation-tail-held.png` | Inside the pane, the feed is again the word "Loading…". |
| `desk-13-server-down-24s.png` | The header turns red: "Conversations could not be loaded; cards may be missing members." This shows during a routine deploy. |

Measured phone cold start: a stored project, 5 runs, 4× CPU throttling,
80 ms RTT, 10 Mbps (`/var/tmp/skeletons/before/measure.json`). Medians:

| milestone | throttled | unthrottled |
| --- | --- | --- |
| first contentful paint (the desktop overview, see above) | 332 ms | 68 ms |
| first phone-shell frame (the title is the raw key) | 1565 ms | 267 ms |
| display name and first conversation row | 1883 ms | 328 ms |
| CLS over 4 s after load | 0.0004 | 0 |

**Wrong-frame time** is 1233 ms throttled: the span during which a 390 px phone
paints a desktop layout that falsely says nothing exists. **Raw-key time** is
318 ms throttled. CLS is near zero because every step *replaces* the previous
frame outright. The measurable defect is the sequence of wrong-shaped frames,
so the targets below add a wrong-frame count beside CLS.

Production scale, from one read-only request to the running instance: `GET
/api/files` returns 1.67 MB compressed (8.2 MB of JSON). With the same ETag
it answers `304` with an empty body. On a phone over LTE the full body alone is
over a second, which is the "noticeable time" in the issue.

### Why the header shows the raw key

`useFiles` starts from `EMPTY`, whose `projectDisplayNames` is `{}`
(`src/hooks/useFiles.ts:77`). `Viewer` restores the stored project in an effect
(`src/components/Viewer.tsx:288-296`) and passes `projectDisplayNames[project]`,
which is `undefined` until the first `/api/files` answer lands
(`Viewer.tsx:1178`). `ProjectDashboard` then calls
`projectDisplayName(project, undefined)` (`src/components/ProjectDashboard.tsx:453-456`).
For a `repo-<hash>` or `dir-<hash>` key, `projectDisplayName` returns the key
itself (`src/lib/displayNames.ts`, the final `undashed || project`). Nothing
on the client remembers a name from the previous visit, so every cold start
passes through this frame. The phone bar (`ProjectDashboard.tsx:2221`) and the
desktop header `<h1>` (`ProjectDashboard.tsx:2027`) render the same value.

### Why the first paint is the desktop overview

`Viewer` initialises `project` to `OVERVIEW` (`Viewer.tsx:138`). `useIsMobile`
returns `false` on the server (`src/hooks/useIsMobile.ts:25-31`). The server
therefore renders the desktop overview with no data. `OverviewBoard` shows the
first-run panel whenever there are no summaries, without checking `loaded`
(`src/components/OverviewBoard.tsx:128`), and its subtitle says "nothing is
running right now" (`OverviewBoard.tsx:236-240`). Hydration keeps that frame
until the bundle runs. Then the phone overview renders, then the effect
switches to the stored project. That is three different layouts before any
content.

## Inventory

A **verdict** of *keep* means the state is already correct and this PR leaves
it alone. *Fix* means it changes here. *Defer* means it moves to the last
section.

### Loading

| surface | where | today | verdict |
| --- | --- | --- | --- |
| First paint, both form factors | `Viewer.tsx:138`, `useIsMobile.ts:25-31`, `OverviewBoard.tsx:128` | Desktop overview with a false first run. | **Fix** (D1) |
| Project board skeleton, both | `src/components/scheme/SchemeSkeleton.tsx:14-40`, used at `ProjectDashboard.tsx:2241-2242` and `:2355-2356` | Six 3-bar cards in an auto-fill grid; the shape of neither board. | **Fix** (D3) |
| Board gate | `ProjectDashboard.tsx:235-237, 484` (`boardFirstPaintReady` = scan loaded && board state loaded) | Two round trips before anything. | **Fix** (D4, D5) |
| Header name | `ProjectDashboard.tsx:453-456, 2027, 2221` | Raw key. | **Fix** (D2) |
| Desktop header status | `ProjectDashboard.tsx:2136-2139` | "nothing is running right now" while loading. | **Fix** (D6) |
| Kanban without data | `src/components/kanban/KanbanBoard.tsx:2346-2347` | Centred text "Loading the board…" (the Overview's kanban). | **Fix** (D3) |
| Overview | `OverviewBoard.tsx:112-135, 236-240` | First-run panel and "nothing running" while loading. | **Fix** (D6) |
| Rail | `src/components/ProjectRail.tsx:343-353` | Spinner with "loading…". | **Fix** (D3, D4) |
| Phone project sheet | `src/components/mobile/MobileProjectSheet.tsx:129-133` | Spinner with "loading…". | **Fix** (D3, D4) |
| Phone dock | `ProjectDashboard.tsx:2229-2236` (only when `boardReady`) | The bottom edge pops in when the board lands. | **Fix** (D3) |
| Conversation feed, never opened | `src/components/LogFeed.tsx:1476, 1581-1591` | "Loading…" at 14vh. | **Fix** (D3) |
| Conversation feed, opened before | `src/hooks/useLogTail.ts:125-130`, `src/hooks/logTailStore.ts` | Cached tail in memory, and persisted across reloads (#1821). | **Keep** |
| Phone focus-view leaf | `src/components/mobile/MobileFocusView.tsx:652-660` | Spinner with "loading…". | **Fix** (D3, same row skeleton) |
| Conversation list | `src/components/ConversationList.tsx:77-80` | Spinner with "loading…". | **Fix** (D3) |
| Orchestrator panel and dock (desktop) | `src/components/orchestrator/OrchestratorPanel.tsx:541-545` | Centred spinner with "Loading…". | **Fix** (D3, feed skeleton) |
| Phone seat card | `src/components/mobile/MobileSeatCard.tsx:588-599`, `orchestratorRowState.ts:159` | "reading" chip, final geometry. | **Keep** |
| Account panel | `src/components/AccountsPanel.tsx:887, 1391` | The line "Loading accounts…". | **Fix** (D3) |
| Setup guide | `onboarding/AgentMappingTable.tsx:365`, `VoiceStep.tsx:265`, `PhoneStep.tsx:130`, `EnginesStep.tsx:75` | Shaped pulse blocks with `motion-reduce:animate-none`. | **Keep** |

### Empty

| surface | where | verdict |
| --- | --- | --- |
| Overview first run | `OverviewBoard.tsx:128-170` | **Fix**: show only after a certified empty answer (D6). |
| Empty project | `ProjectDashboard.tsx:305-345` (`EmptyProjectLeaf`) | **Keep**, reached only when loaded. |
| Phone "Nothing running" under Working | `src/components/mobile/MobileBoard.tsx:503` | **Keep**. |
| Kanban column empties | `KanbanBoard.tsx` ("Nothing in progress", …) | **Keep**. |
| Feed empty / no output | `LogFeed.tsx:1585-1591` | **Keep**. |
| List empty | `ConversationList.tsx:94` | **Keep**. |

### Error

| surface | where | verdict |
| --- | --- | --- |
| Catalog failure with no data | `src/components/CatalogFailureNotice.tsx`, `ProjectDashboard.tsx:2242, 2356`, `OverviewBoard.tsx:112` | **Keep** the notice. It now sits under a named header (D2). |
| Files failing with data present, desktop | `ProjectDashboard.tsx:2136-2138`, `KanbanBoard.tsx:2293, 2312` | **Fix**: red only once offline (D7). |
| Seat unreadable | `orchestratorRowState.ts:160` → `orchMobile.unreadable` | **Fix**: a transport failure keeps the last known state (D7). |
| Feed read failed | `LogFeed.tsx:1586` | **Keep**. |
| List failed | `ConversationList.tsx:84` | **Keep**. |
| Kanban move/edit failures | `KanbanBoard.tsx:764-1018` (receipt toasts) | **Keep**. |

### Stale and reconnecting

| surface | where | today | verdict |
| --- | --- | --- | --- |
| Runtime bus state machine | `src/hooks/runtimeBus.ts:41-56, 445-470` | live → reconnecting → degraded at 15 s → offline at 60 s. | **Keep** as the signal. |
| Desktop connection pill | `src/components/ConnectionPill.tsx:91-105` | Floats bottom-left on trouble states. | **Keep**. |
| Phone banner | `src/components/mobile/MobileShell.tsx:61-65, 125-147` | In-flow banner for offline and degraded (pushes content by 44 px); nothing for reconnecting. | **Fix** (D7) |
| Files poll failures | `useFiles.ts:266-272` (`catalogFailures`) | Keeps the last good list. | **Keep**, and add `firstFailureAt` (D7). |
| Deploy pill | `src/components/runtime/DeploymentStatusPill.tsx` | Desktop only, behind a flag. | **Keep**. |

### Transitions

| transition | where | today | verdict |
| --- | --- | --- | --- |
| Phone screen push/pop | `MobileShell.tsx:153-157, 245` | 200 ms, starting from `opacity-0` on a remounted screen: the first frame is blank canvas. | **Fix** (D8) |
| Phone project switch | `MobileShell.tsx:156` (`switch`) | Fades from `opacity-0`: a blank frame. | **Fix** (D8) |
| Phone sheets | `src/components/mobile/MobileSheet.tsx:109, 133` | Enter at 320 ms with translate+opacity over visible content; drag release at 200 ms; exit instant. | **Keep** (exit is deferred) |
| Skeleton → content | `ProjectDashboard.tsx:2241` | Instant swap between different shapes. | **Fix** by matching the shape (D3). |
| Cached → fresh | none today on a cold start | | **New** (D4) |
| Desktop dock / task panel | `src/components/orchestrator/OrchestratorDock.tsx:204`, `ProjectDashboard.tsx:2080` | Opens in one layout step. | **Keep** (deferred) |
| Kanban wide-share swap | `src/components/kanban/kanbanBoard.css:155` | `grid-template-columns` over the base duration. | **Keep** |
| Desktop dialogs | `OnboardingDialog`, `AccountsPanel`, `GlobalSearch`, `SelfUpdateDialog`, `StagesSheet` | Pop in; no flash, no jump. | **Keep** (deferred) |
| Scheme node enter | `src/app/globals.css:311-325` | 300 ms fade, reduced motion off. | **Keep** |

## Decisions

### D1. The server renders a responsive boot shell, and the app mounts client-side

Options considered:

1. **Sniff the viewport on the server** (User-Agent or Client Hints). This is
   unreliable for landscape phones and for an iPad, and the server still does
   not know the stored project or its name, which live in `localStorage`.
2. **Hide the SSR tree until hydration.** Same wait, and a blank frame instead
   of a wrong one.
3. **A CSS-responsive boot shell** (chosen). `Viewer` renders `<BootShell/>`
   on the server and in the hydration render, then renders the real tree after
   mount.

`BootShell` draws both shells and shows one by media query. The query is built
from the same `MOBILE_LAYOUT_QUERY` constant `useIsMobile` uses, so the
breakpoint cannot drift. On a phone it draws the 52 px bar, the board skeleton
(D3) and the dock placeholder. On a desktop it draws the 248 px rail with row
skeletons, a 48 px header and the kanban skeleton. An inline script placed
directly after the title cell reads `location.hash` (`#p=`), `llvProject`,
`llv_lang` and the name cache (D2), then writes the title text before first
paint. This follows the existing `ROLE_FRAME_BOOT_SCRIPT` pattern in
`src/app/layout.tsx`, and the title element carries `suppressHydrationWarning`.

The real tree mounts only on the client. Its state initialisers can therefore
read the hash and `localStorage` synchronously
(`initialProjectFromState(location.hash, localStorage.getItem("llvProject"))`),
and the restore effect at `Viewer.tsx:288-296` goes away. The phone overview no
longer appears for a frame before the project.

Nothing of value is lost by not server-rendering the real tree: today's server
frame has the wrong layout on phones and the wrong content everywhere.

### D2. A name is cached; a key is never rendered

- `localStorage["llvProjectNames"]` holds `{ [projectKey]: displayName }`,
  written only when `projectDisplayNames` changes identity (it is
  reference-stable in `useFiles.ts:207-209`). It is capped at 300 entries and
  used by `BootShell`, `Viewer` and `ProjectDashboard`.
- Name resolution, one function in `src/lib/displayNames.ts`:
  1. the live `projectDisplayNames[key]`, then
  2. the cached name, then
  3. `projectDisplayName` for a readable key (the dash slugs it already
     cleans).
  4. An opaque key (`/^(repo|dir)-[0-9a-f]{16,}$/`) is never returned. While
     not yet loaded, the title renders a 96×12 px skeleton bar. After a
     certified load it renders `dash.projectUnnamed` ("Unnamed project" /
     "Проєкт без назви").
- The rail, the phone project sheet, the overview project names and the menu
  sheet title (`ProjectDashboard.tsx:2093`) all go through the same function.

### D3. Skeletons in the shape of what replaces them

A single module, `src/components/skeletons.tsx`, holds four shapes. Each takes
its geometry from the component it stands in for (measured in the before frames
at DPR 2):

- **`BoardRowsSkeleton`** (phone board, focus-view leaf, conversation list,
  project sheet, rail):
  - Section headers carry the real labels ("Orchestrator", "Working", both
    static i18n) at `min-h-[34px] px-3 pt-1.5`, the header of
    `MobileBoard.tsx:76`.
  - A seat placeholder at the seat card's 56 px height.
  - Rows at `min-h-14`, the `CARD` radius, `gap-1.5`, `px-3`, as in
    `MobileBoard.tsx:162`. Each row has an 8 px dot, a title bar (12 px high,
    58–72 % wide, varied per row by index), and a meta bar (10 px, 38–46 %).
    No chevron.
  - As many rows as fit the viewport (eight at 844 px), so the list does not
    end halfway down the screen.
  - The rail variant is 44 px rows without the dot. The list variant uses
    `bg-quiet` like Recent rows.
- **`KanbanSkeleton`** (desktop project board and the overview kanban):
  - The seat box at the height and fold state `kanbanSeatStore` already holds
    in `localStorage` (read synchronously).
  - Four wells with the real column headers (Inbox, Assigned, Blocked, Done,
    translated) using the `.kb .board` grid tracks from
    `kanbanColumnTracks`.
  - Two card placeholders in Inbox, one in Assigned, none elsewhere.
  - It replaces both `SchemeSkeleton` and `KanbanBoard.tsx:2346-2347`, and
    `SchemeSkeleton.tsx` is deleted.
- **`FeedSkeleton`** (a conversation feed with no cached tail, and the
  orchestrator panel while `state.kind === "loading"`): bottom-anchored like
  the feed. From the bottom up: an assistant block of three bars (full,
  full, 60 %), a right-aligned user bubble at 55 % width, and one more
  assistant block. The composer and the bar stay real, as they are today.
- **`AccountRowsSkeleton`**: two 44 px rows (name bar, meter bar), replacing
  the text at `AccountsPanel.tsx:887, 1391`.

The phone dock is always rendered: `MobileBoardDock` with its neutral
`mobile2.board.orchestrator` label and `unresolved` set until the seat answers.
The bottom edge therefore never pops.

Skeleton tone: bars in `bg-sunken` on `bg-card` (phone rows use `bg-quiet`
where the real row is quiet). Only the bars animate: opacity 1 → 0.55 over
1.6 s, ease-in-out, repeating. The animation starts after a 400 ms
`animation-delay`, so a load under 400 ms never pulses. Under reduced motion
the bars are static. Every skeleton root keeps `role="status"`,
`aria-busy="true"` and the translated `sr-only` label it has today.

The swap from skeleton to content is instant with no fade. The geometry is the
same, and a fade over the same geometry reads as flicker and delays readable
text.

### D4. Cached-first board: the last certified `/api/files` representation in IndexedDB

Options considered:

1. **A per-project subset in `localStorage`.** It would be smaller (a busy
   project is several hundred KB, still over the origin budget #1821 keeps).
   Revalidating it still downloads the full 1.67 MB before anything is fresh,
   and the rail and overview get nothing.
2. **The whole representation plus its ETag in IndexedDB** (chosen). The
   client cache already keeps `{ etag, raw }` per scope and sends
   `If-None-Match` plus the delta header (`useFiles.ts:514-517, 902-914`).
   Restoring that entry makes the first request of a new document a
   conditional one: `304` with an empty body when nothing changed (verified
   against production), a delta when the server still holds the base, or a
   full body when it does not. The payload is unchanged, there is no new
   request, and a cold start usually transfers **less** than today.
3. **A service worker cache of the Response.** It is a new subsystem with its
   own update and lifecycle risk, and `caches` exists only in secure contexts,
   which rules out plain-HTTP LAN access. Deferred.

Mechanics (`src/lib/client/filesSnapshotStore.ts`, native IndexedDB, no
library):

- **What is stored.** One record in store `snapshot` of database
  `delegatus-boot`: `{ version, savedAt, etag, text }`. `text` is the raw
  global-scope body. Pinned scopes (`#c=`/`#f=` deep links) are never stored.
  `servedPayloadSecrets.test.ts` already guarantees the body carries nothing
  the page was not served.
- **When it is written.** After the first certified load of a document, and on
  `visibilitychange → hidden`. Only when the ETag differs from the stored one,
  and on idle time.
- **Bounds.** `text` at most 24 MB, otherwise not stored. A record older than
  7 days or with a different `version` is dropped on read. A `401`/`403` from
  `/api/files` clears the store.
- **Restore.** `createFilesClientCache` gets `hydrate(record)`. It parses
  `text` through the existing `parsedFilesData` and calls
  `rememberRepresentation(url, data, etag, raw)`, so the first fetch is
  conditional. It then publishes a copy flagged
  `{ loaded: false, cached: true, scopeCertified: false }`. A `304` answer
  publishes the stored data with `loaded: true`. Rows keep their identity
  (`patchFilesData`), so nothing re-renders that did not change.

**The `cached` contract.** `loaded` keeps its meaning of *certified by the
network in this document*, and every effect that acts on data stays gated on
it: the reviewer auto-close (`ProjectDashboard.tsx:1476`, via `board.loaded`),
draft restoration (`:615`), `viewBus.reportCards` (`:1873`), selection pruning
(`:1891`), the catalog-pin release and chimes (`Viewer.tsx:202, 576, 599`,
already gated on `scopeCertified`). Only rendering reads `loaded || cached`:
`boardFirstPaintReady`, the rail, the overview, the phone project sheet and
`useMobileInlineCatalog`'s enable. That makes the change default-deny: code
nobody touched cannot act on a stale snapshot.

While `cached && !loaded`, the header status (desktop) and the bar meta line
(phone, D7) read `dash.updating` ("updating…" / "оновлення…"). Cards stay
interactive. Opening a conversation needs nothing from the snapshot, and a
board write against a stale revision takes the existing 409 path.

### D5. Board arrangement: persist the last confirmed board per project

`useBoardState` already keeps a session cache of server-confirmed boards
(`src/hooks/useBoardState.ts:158-170, 982-984`) and fences writes queued
against a cached revision. This PR persists the last six projects' confirmed
boards to `localStorage["llvBoards"]` (at most 64 KB, least recently used
evicted first). On a new document a persisted board seeds a snapshot with
`cached: true` and `loaded: false`. Reviewer auto-close stays gated on `loaded`.
`boardFirstPaintReady(scanReady, boardReady)` takes `loaded || cached` on both
sides. A project switch in a new document therefore paints at once for any
project visited recently.

### D6. Loading never borrows an empty or false statement

- The overview first run (`OverviewBoard.tsx:128`) requires `loaded`. Before
  that, the overview draws `KanbanSkeleton` (desktop) or `BoardRowsSkeleton`
  (phone).
- The overview subtitle (`OverviewBoard.tsx:236`) and the dashboard status
  (`ProjectDashboard.tsx:2139`) show `common.loadingCap` while neither `loaded`
  nor `cached` holds, and `dash.updating` while only `cached` holds. "nothing
  is running right now" requires `loaded`.

### D7. Reconnecting is visible and quiet

There is one derived state and no new request: `useServerReach()`, built from
the runtime bus `connection`/`lastEventAt` and a new `firstFailureAt` that
`useFiles` keeps beside `catalogFailures`.

- `ok`: the bus is live or disabled, and no files failure is outstanding.
- `reconnecting`: the bus has been `reconnecting`/`degraded` for more than
  2 s, or a files poll failed while data is on screen, and less than 60 s have
  passed since the first failure. The 2 s floor keeps a one-off blip from
  drawing anything.
- `offline`: 60 s or more since the first failure, or the bus is `offline`.
  This is the bus's own `OFFLINE_AFTER_MS`.

Presentation:

- **Phone, any screen.** While `reconnecting` (or `updating`, D4), the bar's
  title cell becomes two lines inside the fixed 52 px bar: the name, then a
  `text-label text-muted` line with a static 6 px `bg-warning` dot and
  `reach.reconnecting` ("reconnecting · showing {time}" / "перепідключення ·
  показано стан на {time}"). `{time}` is the last good answer as `HH:MM`, the
  format `MobileShell` already uses. On the chat screen the same line replaces
  the meta line, which `ChatBarTitle` already blanks while offline
  (`MobileFocusView.tsx:847-866`). This causes zero layout shift and covers
  nothing. The in-flow banner stays for `offline` only (`bannerKind` drops the
  `degraded` case), because at that point the operator needs to know that
  actions may fail.
- **Desktop.** While `reconnecting`, the header status
  (`ProjectDashboard.tsx:2136`) and the kanban bar alert
  (`KanbanBoard.tsx:2293, 2312`) read `reach.reconnecting` in `text-muted`
  and without `role="alert"`. The red `kanban.filesFailed` text is kept for
  `offline`. `ConnectionPill` is unchanged.
- **Seat.** A failed seat or incumbent re-read never replaces a known state
  with `unavailable`. `orchestratorRowState` maps `unavailable` to
  "unreadable" only when no status was ever read in this document, or when
  reach is `offline`.
- **Recovery.** The line disappears on the first good answer. Rows update in
  place, with no toast on the phone and the existing "resynced" note on the
  desktop pill.

### D8. Motion

This follows `docs/design/viewer-design-system.md` §1.6: 120, 200 or 320 ms
with `--ease-standard`, and everything off under `prefers-reduced-motion`.

| transition | motion | reduced motion |
| --- | --- | --- |
| Phone push / pop (board ↔ conversation, pipeline, accounts) | `translate-x-6 → 0` (pop `-translate-x-6`), 200 ms, **opacity stays 1**: drop `starting:opacity-0` from `MobileShell.tsx:154-155`. The new screen paints its cached content (D4, #1821) or its shaped skeleton in the first frame. | None |
| Phone project switch | None. Drop `starting:opacity-0` at `MobileShell.tsx:156`. The board repaints in place from the snapshot, and the bar title changes. | None |
| Sheets | Unchanged: enter 320 ms, translate-y plus opacity over the content that stays visible; drag release 200 ms. | None (as today) |
| Skeleton → content, cached → fresh | None: same geometry, keyed rows. | None |
| Skeleton bars | Opacity pulse, 1.6 s, after a 400 ms delay. | Static |
| Reconnecting line | Appears and disappears without motion inside the fixed bar. | None |

## New strings (en / uk)

| key | en | uk |
| --- | --- | --- |
| `dash.projectUnnamed` | Unnamed project | Проєкт без назви |
| `dash.updating` | updating… | оновлення… |
| `reach.reconnecting` | reconnecting · showing {time} | перепідключення · показано стан на {time} |
| `reach.reconnectingShort` | reconnecting… | перепідключення… |

`reach.reconnectingShort` is used when no last-good time is known. Column
labels, section labels and loading labels reuse existing keys.

## Tests (DOM, happy-dom, by path)

1. **The header shows the display name, never the key, while loading.** Render
   `ProjectDashboard` in phone and desktop modes with `loaded=false`, no
   `projectName`, and the invented key
   `repo-0123456789abcdef0123456789abcdef`:
   - with `llvProjectNames` holding `atlas`, the title reads `atlas`;
   - with no cached name, the title is the skeleton bar;
   - in both cases the header's text never matches `/(repo|dir)-[0-9a-f]{8,}/`;
   - loaded with no name, the title reads `Unnamed project` (en) and
     `Проєкт без назви` (uk).
2. **Skeleton shapes per surface.**
   - `BoardRowsSkeleton` renders the Orchestrator and Working labels, a seat
     placeholder and rows with the row classes (`min-h-14`, dot, two bars).
   - `KanbanSkeleton` renders four columns with translated labels in en and uk,
     and reads the seat height and fold state from `kanbanSeatStore`.
   - `FeedSkeleton` is bottom-anchored.
   - `SchemeSkeleton` is gone, and every skeleton root has `aria-busy`.
3. **Cached-first render.** This uses an in-memory implementation of the
   snapshot-store seam, since happy-dom has no IndexedDB:
   - rows paint from the restored snapshot before the fetch resolves, with
     `cached: true` and `loaded: false`;
   - the first request carries `If-None-Match` with the stored ETag;
   - a `304` certifies without replacing row objects;
   - while cached, the reviewer auto-close and `reportCards` do not run.
4. **Boot shell.** `renderToString(<Viewer/>)` contains both shells, the
   media-query style, and no first-run text and no "nothing is running".
5. **Overview while not loaded** shows the skeleton, never `overview-first-run`.
6. **Reconnect.**
   - Files failures under 60 s give the phone bar meta line and no banner;
     the desktop status is muted, with no `role="alert"`.
   - At 60 s or more, the existing offline banner and the red alert show.
   - The seat keeps its last state while reconnecting.
7. **Motion.** The push and switch screens carry no `starting:opacity-0`, and
   the skeleton bars carry `motion-reduce:animate-none`.

## Measurement plan and targets

**Driver.** Add a `board` target to `scripts/profile-reopen.ts`. It already
serves the production build, seeds a catalog-sized invented corpus (nine
background projects of twenty conversations plus the measured project), sets
and reads back 390×844 metrics, repeats cases for medians, and has exactly the
two cases this needs:

- `cold`: empty storage.
- `reopen-reload`: a new document with storage kept.

Per case, record:

- the painted-frame milestones `shell` (`[data-mobile2-bar]`), `name` (the
  title text equals the display name) and `content` (first
  `[data-mobile2-row="conversation"]`), using its existing two-frame
  confirmation;
- a requestAnimationFrame-sampled **wrong-frame detector** that counts any
  painted frame at 390 px containing the desktop rail,
  `[data-testid="overview-first-run"]`, or a title matching the opaque-key
  pattern;
- CLS from a `layout-shift` `PerformanceObserver` over 5 s;
- transferred `/api/files` body bytes, and the count of `/api/*` requests in
  the first 5 s.

**Conditions.** 4× CPU throttling, 80 ms RTT, 10 Mbps. An isolated seeded
config root, a server on a port the OS assigns, run only when `free -m` shows
at least 6 GB available, and stopped by its recorded PID. Local PNGs go to
`/var/tmp/skeletons/after` (phone 390 and desktop 1080 and 1440, en and uk),
next to `/var/tmp/skeletons/before`.

| metric | before (seeded, throttled median) | target |
| --- | --- | --- |
| wrong frames at 390 px | ≈ 1233 ms of desktop overview + 318 ms of raw key | **0 frames** (hard gate) |
| name visible | 1883 ms | at first paint on any visit after the first; a title skeleton bar, never the key, on a first-ever visit |
| phone shell visible | 1565 ms | at first paint, ≤ 400 ms |
| first conversation row, `reopen-reload` | 1883 ms | ≤ client mount + 150 ms, and ≤ 0.6 × the `cold` median on the catalog-sized corpus |
| first conversation row, `cold` | 1883 ms | no regression: ≤ 1.05 × before |
| CLS, 5 s after navigation | 0.0004 | ≤ 0.01 in both cases |
| skeleton → content geometry | none (shapes differ) | first Working row top and section header top move ≤ 2 px |
| `/api/files` body on `reopen-reload`, nothing changed | full body (1.67 MB compressed in production) | 0 bytes (`304`) |
| `/api/*` requests in the first 5 s | baseline from the driver | ≤ baseline |

## PR shape

One PR, four commits:

1. D1 + D2 + D6 (the wrong frames).
2. D3 (the shapes).
3. D4 + D5 (cached-first).
4. D7 + D8 (reconnect and motion).

Gates: `bunx tsc --noEmit --incremental false` logged to a file with its exit
code checked; the new and touched tests by path; `bun run build` under an
isolated config root; the privacy gate. The PR body carries "Closes #2071",
the before/after table, and the paths of the two local PNG directories. No
raster is committed.

## Deferred — not currently justified

- **Exit animations for sheets and dialogs.** They need a deferred unmount in
  every sheet owner. Opening is the moment the operator waits on, and an
  instant close has no blank frame or jump.
- **Entry motion for desktop dialogs.** A pop-in measured no flash and no
  shift.
- **Animated width for the dock and task panel.** Animating width reflows the
  whole kanban on every frame. One reflow on the operator's own click is the
  expected result of that click.
- **The View Transitions API for screen changes.** D8's slide without the
  opacity drop already removes the blank frame. A snapshot-based crossfade
  adds cost on large boards and a fallback path.
- **A service worker or offline HTML shell.** Mount time on LTE is dominated
  by the JS bundle, which a worker could cache, but that is a new subsystem
  with its own update risk, and the requirement is met without it.
- **Persisting seat status, accounts or limits.** Each lands within one poll
  and now has a shaped placeholder.
- **Per-project shape hints** (row and card counts per column) for a first-ever
  visit. After one visit the snapshot shows the real thing.
- **Server-side viewport detection** (User-Agent or Client Hints). See D1.
- **A shimmer gradient on skeletons.** The pulse, delayed 400 ms, is enough,
  and a moving gradient is a second motion vocabulary.

## Validation against the requirement

| requirement | where it is met |
| --- | --- |
| Inventory with screenshots of each state today | Inventory tables; `/var/tmp/skeletons/before/` |
| Skeletons shaped like what replaces them | D3 |
| No raw key or id; cached or known name in the header | D1 (boot script), D2 |
| Cached content first (last board, last conversation tail), revalidated behind | D4, D5; the tail is #1821, kept |
| No layout shift when data lands | D3 (same geometry), D4 (keyed in-place refresh), D7 (reconnect line inside the fixed bar); CLS and geometry targets |
| No blank frame between screens | D1 (no wrong first frame), D8 (no `opacity-0` start) |
| Short motion that honours reduced motion | D8 table |
| Visible but quiet reconnecting state | D7 |
| Design system; en and uk | §1.6 durations and tokens; the strings table |
| Measure before and after on the phone board | Measurement plan; the before numbers above |
| Traffic budget: no new polling, no bigger payload | D4 reuses the existing conditional request (a `304` saves the body); D7 adds no request |

## Implementation and results

Built as designed, with three differences:

- **Commits.** Two feature commits (D1 D2 D3 D6, then D4 D5 D7 D8), each
  with its tests, and a merge of `main`.
- **Measurement driver.** The before frames were taken with an out-of-repo
  playwright-core script over the seeded home of
  `scripts/capture-mobile-v2.ts`. The after frames and both sets of numbers
  come from the same script, extended with a `reopen-reload` case, the
  wrong-frame counter, `/api/files` status and bytes, and the `/api/*` count.
  Both builds were measured with the extended script, so the table compares
  like with like. No driver was added to the repository.
- **Loading surfaces kept.** The phone orchestrator sheet keeps its spinner.
  It is a sheet over content that is already shaped, and the inventory
  listed it as keep.

Production builds (`next build --webpack`) of the merge base and of this
branch, served by `next start` under Bun 1.4.0, on an isolated seeded config
root and a port the OS assigned. Phone 390×844 at DPR 2, 4× CPU throttling,
80 ms RTT, 10 Mbps. Medians of five runs, in ms from navigation start.

| metric | before | after |
| --- | --- | --- |
| wrong frames at 390 px (desktop rail, first run, raw key) | 55 frames, 1750 ms | **0** |
| phone shell painted | 1699 | **287** |
| name in the title, `reopen-reload` | 1977 | **285** (first paint) |
| name in the title, first visit | 2048 (raw key before it) | 1832 (placeholder bar before it) |
| first conversation row, `cold` | 2048 | 1832 |
| first conversation row, `reopen-reload` | 1977 | 1677 |
| CLS over 5 s, `cold` / `reopen-reload` | 0.0004 / 0.0004 | 0.0001 / 0.0005 |
| `/api/files` on `reopen-reload`, nothing changed | 200, full body | **304, 0 bytes** |
| `/api/*` requests in the first 5 s | 15 | 9 |

The `reopen-reload` row lands about 40 ms after the app mounts, which meets
the "client mount + 150 ms" target. It misses the "≤ 0.6 × cold" target. On
this seed the whole `/api/files` body is about 2 KB, so the cold path is also
mounting plus one small request, and the bundle's mount under 4× throttling
dominates both cases. The saving the snapshot buys scales with the catalog;
production's 1.67 MB compressed body is exactly the part a `304` removes.
The frames are in `/var/tmp/skeletons/after/`: the before set, plus 1080 px
desktop frames and the `15`/`16` reload-with-cache frames.
