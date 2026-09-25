# Desktop first run leads with the orchestrator (#2166)

Design only. Grounded in `origin/main` at `c675693d0` (2026-09-25), one commit
past the lane's base (#2160, interface polish); every `file:line` below was
read at that commit. No product code was changed in this repository. The
mockups are HTML drawn with the product's own stylesheet, and the phone board
is shown as real renders of that commit, as it is and with the slice-1 change
applied in a scratch export (see §7). All of them live outside the repository,
because rendered rasters are never committed here.

## 0. Originating requirement

Source: the operator's message to the Delegatus orchestrator seat, 2026-09-24,
dictated in Russian. Repository rule: the operator's words reach GitHub-facing
text only as an English paraphrase, so this is a close translation with the
dictation noise removed (paraphrased in English):

> One problem I want to record right away from this newcomer's path: what does
> he do? He creates a task, while our whole idea is to use the orchestrator.
> I would like the accent to be on the orchestrator, not on the board, so that
> the first thing offered is to create the orchestrator. I think the phone
> already does this and the desktop does not. So we need to push harder toward
> creating the orchestrator, and walk the person through the interface: this is
> the orchestrator, it will take care of the tasks; you just watch and give it
> work. That's all.

Issue #2166 (opened 2026-09-24 from that message), "What we want" and
"Acceptance", verbatim:

> Orchestrator-first on desktop, matching the phone:
>
> 1. After engines are connected and a project exists, the first thing offered
>    is **Create the orchestrator for this project**, with one plain sentence:
>    the orchestrator takes your requests, opens the tasks, runs the agents and
>    reviews, and reports back; you watch and give it work.
> 2. A short guided walk through the interface once the orchestrator exists:
>    where you talk to it, where its tasks and agents appear on the board, what
>    "Needs you" catches. Skippable, reachable again from the menu.
> 3. The board's manual "New task" / "+ Agent" stay available but are secondary
>    until an orchestrator exists.
> 4. The setup guide ends by creating the first project and its orchestrator
>    instead of a dead end.
>
> Acceptance
>
> - A fresh install (isolated home) reaches a running orchestrator from the
>   setup guide without touching "New task".
> - Desktop at 1440 and 1280 and phone at 390 renders shown before merge.
> - Depends on the orchestrator-cwd fix for newly created projects (Create
>   orchestrator currently fails with cwd_unresolved on a project created
>   seconds earlier) and on Claude sign-in working for npm-installed Claude.

The lane's pinned brief adds three specifics this design must meet: the draft
in plain language with no issue numbers, no MCP install line for bunx
installs and no auto-deploy by default, with the full mandate folded; the
walk reachable again from the menu; and B1/B2 named as dependencies with a
decision on whether they ship first.

Evidence: the newcomer audit of 2026-09-25 (outside the repo, `newcomer-journey-2026-09.md`
under the operator's review folder), steps 7–29 and its sections 3–5, and its
screenshots 07, 18-setup-step2…6, 19, 23, 24, 25, 29, 33, 37–38.

## 1. What the code does today

### 1.1 The setup guide never offers an orchestrator

- The guide has six steps, `ONBOARDING_STEP_IDS = ["engines", "agents",
  "phone", "voice", "tour", "check"]` (`src/lib/onboarding/steps.ts:7`),
  walked in that order (`src/components/onboarding/OnboardingDialog.tsx:32`,
  `next()` at `:213-223`).
- The only orchestrator content is the Tour's "Start here" band
  (`src/components/onboarding/TourStep.tsx:42-141`), step 5 of 6. It needs a
  project to exist already; with none it prints "No projects yet. Open a folder
  with a repository first: the board's "Create a project""
  (`src/lib/i18n/en.ts:4157`), and the desktop has no control with that label
  (audit F27). Its button is Claude-only and disabled without Claude
  (`TourStep.tsx:57, 121`). When it works it opens the board's draft through
  `requestOrchestratorDraft` (`src/components/orchestrator/draftPrefill.ts:40-50`),
  which the Viewer answers by selecting the project and expanding its seat
  (`src/components/Viewer.tsx:608-615`). Nothing is created until the
  draft's own Create is pressed.
- The guide ends on the Check step, which with no engine shows "Connect an
  engine first (step 1)." (`en.ts:3994`, rendered at `CheckStep.tsx:284` when
  `noEngineShown`, `:267`, holds) and the footer
  button "Open the board". The newcomer pressed it (audit step 20).

### 1.2 The Overview never says "orchestrator"

- The first-run panel with "Create a project" exists
  (`src/components/OverviewBoard.tsx:196-227`) but renders only when the
  catalog holds no project summaries at all (`:181`). A newcomer who has ever
  run `claude` in a repository has projects, and the audit's fresh home got an
  "Unresolved project" from `/tmp` (audit B4), so the panel never showed and
  the Overview repeated "No agent is working in any project right now" four
  times (screenshot 19).
- The rail's create button carries its label only when the rail is empty
  (`src/components/ProjectRail.tsx:97, 244-270`); otherwise it is a 28 px icon.

### 1.3 A new project opens on its conversation list

`ProjectRail.tsx:276-279` selects the new project. The desktop picks the
Board only when the saved preference says so
(`src/components/ProjectDashboard.tsx:1752-1758`); a project with no saved
preference resolves to Conversations, "No conversations are stored for this
project" (audit step 23, screenshot 23).

### 1.4 The board's draft reads like an operator's runbook

On the project board the seat panel sits above the columns
(`src/components/kanban/KanbanSeat.tsx`) and holds `OrchestratorPanel`'s
draft (`src/components/orchestrator/OrchestratorPanel.tsx:904-1060`):

- Intro (`:950-958`, copy `en.ts:2251-2253`): "«take issues 12 and 14»,
  «review PR 30». It opens lanes, spawns implementers and fresh reviewers, and
  merges on APPROVE. … it deploys on its own unless you edit that out below."
- A status line (`:961-970`, `en.ts:2255`): "viewer MCP: run
  scripts/install-mcp.sh or claude mcp add viewer -- bun ./bin/mcp-server.mjs".
  Both engines already inject the `viewer` server into every spawn when none
  is registered: Claude at `src/lib/agent/spawnPolicy.ts:326`, Codex at
  `src/lib/codexHeadlessConfig.ts:87-89`. The line asks the user to fix
  something that needs no fixing, on any install.
- Engine, account, model and effort pickers, stacked, open by default; the
  effort defaults to `low` (`src/lib/orchestrator/prompt.ts:63-69`) while the
  orchestrator role itself defaults to Claude Opus at `high`
  (`src/lib/roles/defaults.ts:42-45`).
- The mandate, folded, but forced open on any error (`OrchestratorPanel.tsx:902`),
  where it took 60% of the viewport (screenshot 29). Its first line is "You are
  Delegatus's built-in Manager (issues #182, #691)" (`prompt.ts:286`).
- A footer that points the other way (`:1049-1055`, `en.ts:2271`): "One task?
  Spawn one agent and talk to it directly (Create → Agent)."
- The mandate the seat receives has no deploy section since v16 (#1760), and
  `deploy_exact_sha` refuses every project but Delegatus itself
  (`src/lib/mcp/bindings.ts:760-775`). What remains is the conveyor clause
  "… -> merge bar -> this project's own release step, where it has one ->
  cleanup" (`prompt.ts:331`): a seat may run a newcomer's own release script
  (a publish or deploy command) without being asked. The draft's "it deploys on
  its own" is stale for Delegatus deploys and still true for that clause.
- The seat's first message is jargon too: "Tell me what to ship — I open lanes,
  spawn implementers and reviewers, and merge on APPROVE."
  (`prompt.ts:90-94`).

The phone's draft sheet shows the same intro and the same MCP line
(`src/components/mobile/MobileOrchestratorSheet.tsx:589-594, 1260`).

### 1.5 What the phone already does

The phone is orchestrator-first by layout, and this design reuses its
patterns:

- The seat card is the first row of every project board
  (`ProjectDashboard.tsx:2360-2376`). With no seat it is an invitation: "No
  orchestrator" / "Create an orchestrator →" (`MobileSeatCard.tsx:543-550`,
  `en.ts:3086-3087`).
- The board's footer is a 44 px dock that says "Create an orchestrator to talk
  to…" before a seat exists and "Tell the orchestrator…" after
  (`src/components/mobile/MobileBoard.tsx:375-400`, `en.ts:3107, 2927`).
- Both open `MobileOrchestratorSheet`, the phone's draft.
- The phone's empty Assigned column offers "Tell the orchestrator"
  (`src/components/mobile/MobileKanban.tsx:499-503`).

Where the phone is not orchestrator-first yet, seen in real renders of
`c675693d0` (§7, `phone-board-today-*`):

- The empty Inbox's only button is a filled accent "+ New task"
  (`MobileKanban.tsx:499-521`), because `ProjectDashboard.tsx:2383` always
  passes `onNewTask` and no `emptyCopy` is passed. Its label carries its own
  "+" (`en.ts:2794`, `"+ New task"`) beside the `Plus` icon, so it reads
  "+ + New task". The copy above it is "Nothing in the inbox / New tasks land
  here." (`en.ts:3182-3183`). This is the screen right after a seat is
  created (the seat's conversation is the board's only node), and on any
  seatless board whose Inbox is empty, where that filled button is louder than
  the seat invitation and the dock.
- A new project with nothing in it opens on its conversation list on the
  phone, since the desktop's empty-board rule (`ProjectDashboard.tsx:1749-1752`)
  is desktop-only and `resolveProjectView` (`src/components/projectModel.ts:711`)
  finds no nodes. The seat invitation is still the first row above the list,
  and it is the only action on that screen.

What the phone does not have either: the guide's orchestrator step and the
walk. The attention badge in its bar renders only when the count is above zero
(`src/components/mobile/MobileShell.tsx:236, 290`).

### 1.6 The two blockers (audit B1, B2)

Both are filed, together, as #2167 (open, with the reproduction below and
its acceptance). The signed-out preflight this design puts on the
orchestrator's button (§3.3) is one half of #2170.

- **B2, orchestrator cwd for a just-created project.**
  `resolveOrchestratorCwd` (`src/lib/orchestrator/seatCommand.ts:185-203`)
  takes the request's `cwd`, then `LLV_ORCHESTRATOR_CWD`, then the newest
  launch cwd of a conversation already in the project. The panel sends the cwd
  from the files feed's `projectCwds` (`src/app/api/files/response.ts:835-846`),
  which does not yet list a project created seconds earlier. The root the
  create route returns (`src/app/api/projects/create/route.ts:60-66`) and
  stores (`src/lib/projects/curation.ts:182`) is never consulted, so the first
  press answers 400 `cwd_unresolved` (reproduced 2 of 2 in the audit).
- **B1, Claude sign-in for npm-installed Claude.** `ClaudeLoginOperations.start`
  spawns `claude auth login --claudeai` and reads `/proc/<pid>/cmdline` at once
  (`src/lib/accounts/claudeLogin.ts:422-430`). For a `#!/usr/bin/env node`
  script the read often still shows `/usr/bin/env node …/claude auth login
  --claudeai`, which none of the three accepted shapes matches
  (`claudeLogin.ts:91-101`), so the fence refuses with `launch_unfenced` and
  the UI says "Sign-in could not start. Try again."

## 2. Decisions

### 2.1 The guide: three steps, the rest "later"

| Option | For | Against |
|---|---|---|
| Keep six steps, move Tour first and add a Create step at the end | Least code | The newcomer still reads a model table, Tailscale and dictation before the one thing that matters; eight steps |
| **Three steps (Engines → Project → Orchestrator); Agents, Phone, Voice and Check listed under "Later, any time"** | The guide is the path to a running orchestrator and nothing else; every other step stays one click away in the same list and in the menu | The Tour's four cards stop being shown up front (§9) |
| A separate first-run wizard beside the setup guide | Clean slate | Two guides, two markers, two menu rows |

Chosen: the second. The "Later" rows open the same step views they open
today, inside the same dialog; they are unnumbered and never part of Back /
Continue. The Tour step goes away: its "Start here" band becomes step 3, its
seat card's content becomes step 3's three lines, and its Needs-you card
becomes walk stop 3.

### 2.2 Where the orchestrator is created

| Option | For | Against |
|---|---|---|
| Step 3 opens the board's draft (today's Tour behaviour) | No new code path | Two presses and a context switch; the newcomer lands on a form again |
| Step 3 designates the seat itself | One press | A second designation surface beside the draft's `useSeatConfirm`, whose idempotency discipline (`useSeatConfirm.ts:26-48`) would have to be duplicated or extracted |
| **Step 3 hands off to the board's draft with a confirm request** | One press for the newcomer; the one designation path stays the draft's own Confirm | One flag on an existing event |

Chosen: the third. `requestOrchestratorDraft` gains `confirm: true`, and its
`launch` gains the chosen `account`, written to the draft's storage beside
engine, model and effort (`draftPrefill.ts:42-46`). The Viewer already opens
the project and expands the seat for that event (`Viewer.tsx:608-615`).

The confirm cannot ride on the window event. The guide usually closes over the
Overview, and the project's board, its seat panel and the draft mount only
after the Viewer selects the project, by which time the event
(`draftPrefill.ts:49`) has fired to nobody and the one-press create would
silently become a second press. The module already solves this for opening
the phone's sheet: `pendingOpen` is set before the event and
`takePendingSeatOpen` consumes it once on mount (`draftPrefill.ts:28-58`,
`MobileSeatCard.tsx:185-196`). Confirm follows the same shape:

- `requestOrchestratorDraft` sets `pendingConfirm = { project, at }` before it
  dispatches; `takePendingSeatConfirm(project)` returns it once and clears it.
  A request without `confirm` clears any older one.
- The draft (desktop panel or phone sheet, whichever mounts for that project)
  takes it on mount and on the event, and holds it until the draft is ready:
  the seat read says `draft` (no seat), the account and engine options have
  loaded, and the draft's engine, model, effort and account equal the
  request's. Only then does it call its own `onConfirm`, once, through
  `useSeatConfirm` (`useSeatConfirm.ts:26-48`), which keeps its one-key
  idempotency. It never designates on a default account while the prefill is
  still landing.
- If the requested account is missing or signed out once the options load,
  the draft drops the pending confirm and shows the signed-out state (§3.3)
  instead. A pending confirm older than 60 s, or one for a project the user
  has since left, is dropped, so a later visit never designates by itself.

"Read its instructions first" sends the same request without `confirm`,
which is exactly today's Tour hand-off.

### 2.3 The walk

| Option | For | Against |
|---|---|---|
| Static cards in a dialog (the Tour's shape) | No coupling to layout | The operator asked for a walk through the interface itself, and cards show pictures of it |
| A tour library (driver.js, shepherd) | Features | A dependency and a wrapper for three popovers |
| **Three popovers anchored on `data-walk-anchor` elements, the spotlight drawn as one box whose outer `box-shadow` dims the rest** | Native, ~150 lines, works on both layouts | Anchors can be off screen; handled by a fallback (§3.8) |

Chosen: the third.

### 2.4 Deploys

Delegatus deploys are already scoped to Delegatus (`bindings.ts:760-775`), so
the draft sentence "it deploys on its own" goes. The mandate's release clause
changes (§3.7) so a seat runs a project's own release step only when the
operator turned releases on for that project.

Seats that already run keep what they do today. Deciding which of the
operator's projects "has a release step" would be a guess the seat itself
makes today from the clause, so there is no list to check: before v25 is
delivered, every seat that is active at that moment gets one standing line in
its monitor note, "Releases are on for this project: after a merge, run its
own release step where it has one." The Delegatus seat's line adds "deploy
merged work with deploy_exact_sha". On 2026-09-25 the seat store held 15
active seats. It is one `seat_tick_settings` `appendLine` per seat, run at
merge time over whatever is active then; the operator removes a line to turn
a project's releases off. New seats, designated on v25, start with releases
off.

### 2.5 The MCP line

Deleted from both drafts, for every install and both engines, because the
spawn injects the entry itself (§1.4). A seat that cannot reach the Viewer
fails its first turn visibly, and that is where such a failure belongs.

## 3. The flow, screen by screen

```
first open ─▶ Guide 1 Engines ─▶ Guide 2 Project ─▶ Guide 3 Orchestrator
                                                        │ Create the orchestrator
                                                        ▼
                          project board, seat "starting…" → live greeting
                                                        │ seat live (first time)
                                                        ▼
                             Walk 1 talk here ─▶ 2 the board ─▶ 3 Needs you
                                                        │ Give it the first task
                                                        ▼
                                           composer focused, walk done
```

Closing the guide at any step leaves the user on the Overview, where the band
(§3.5) offers the same path again. Nothing is gated: every step closes by
Escape, ✕ or "Close, finish later", as today.

### 3.1 Guide step 1 — Engines

Unchanged content (`EnginesStep.tsx`). The step list is new: three numbered
rows, then "Later, any time" with Agents, Phone, Voice and Check. The counter
reads "Step 1 of 3". With one engine connected, Continue goes on; with none,
Continue still goes on and step 3 says what is missing.

Mockups: `guide-engines-1440.png`, `guide-engines-1280.png`.

### 3.2 Guide step 2 — Project

Heading "Pick the project it will work on"; lead "A project is a folder with
your code, usually a git repository. Its orchestrator works there."

- "Already on this computer": radio rows for the projects the rail lists that
  have a folder on disk (`projectCwds` from the files feed), name, path and
  conversation count, the one the guide opened over preselected, else the
  most recent. Projects without a folder (the "Unresolved project") are left
  out, since an orchestrator cannot work there.
- "Open another folder": the rail's own `CreateProjectForm` inline, the same
  form, the same `/api/projects/create`. With no listed project the form is
  already open (`guide-project-empty-*`).
- Continue records the choice and goes to step 3. A project created here is
  selected at once, so step 3 never waits on the files feed.

Mockups: `guide-project-1440.png`, `guide-project-1280.png`,
`guide-project-390.png`, `guide-project-empty-1440.png`,
`guide-project-empty-1280.png`, `guide-project-empty-390.png`.

### 3.3 Guide step 3 — Orchestrator

Heading "Create its orchestrator"; lead is the one sentence from the issue:
"The orchestrator takes your requests, opens the tasks, runs the agents and
reviews, and reports back. You watch and give it work."

Under it the Tour's accent band, reused (`TourStep.tsx:68`, the seat
schematic from `TourSchematics.tsx`), with three lines:

1. You write to it in its conversation, like to a colleague: "add a delete
   command to todo.py".
2. Each request becomes a task on the board. It starts agents to do the work
   and a separate agent to review it.
3. When it needs you (a question, a plan to approve), "Needs you" shows it.

Two fact rows, each with "Change": **Project** (name and path; Change goes back
to step 2) and **Runs on** ("Claude · Opus 5.5 · high effort · account Main";
Change opens the shared `AgentLaunchControls` inline). The runtime is the
orchestrator role's configuration from the agent mapping (Claude, Opus, high
by default, `defaults.ts:42-45`) when that engine is connected; otherwise the
connected engine with `defaultModelFor(engine)` (`src/lib/agent/models.ts:96-98`)
at high. The Tour's high/medium segment is dropped: Change covers it.

A muted note: "It uses your Claude plan. Between steps it sleeps; it wakes
every 5 minutes, when an agent finishes, or when you write." (the interval is
the seat tick's, as the Tour's card 2 read it).

The step owns the one filled button, "Create the orchestrator", with the text
link "Read its instructions first →" beside it. The footer holds Back and
"Finish without it" (bordered), following the dialog's one-filled-button rule
(`OnboardingDialog.tsx:316-318`).

States:

| State | What shows |
|---|---|
| Ready | as above (`guide-orchestrator-*`) |
| Chosen account signed out | "Claude's account Main is signed out, so the orchestrator cannot start yet." and the button becomes "Sign in to Claude first", which opens that account's sign-in (`guide-orchestrator-signin-*`) |
| No engine connected | "Connect Claude or Codex first." and "Go to Engines" |
| No project chosen | "Pick a project first." and "Go to Project" |
| Project already has a seat | "{project} already has an orchestrator." and "Open it" (today's Tour line) |

Pressing Create writes `orchestrator: "done"` and `completedAt`, closes the
guide, and sends `requestOrchestratorDraft({ project, launch, confirm: true })`.
The Viewer selects the project, switches it to the Board, expands the seat,
and the draft confirms once it is ready (§2.2). The seat panel then shows its existing "creating"
state, and the greeting when the seat is live.

Mockups: `guide-orchestrator-1440.png`, `guide-orchestrator-1280.png`,
`guide-orchestrator-390.png`, `guide-orchestrator-1280-uk.png`,
`guide-orchestrator-390-uk.png`, `guide-orchestrator-signin-1440.png`,
`guide-orchestrator-signin-1280.png`, `guide-orchestrator-signin-390.png`.

### 3.4 After Create

The project opens on its Board. More generally, a desktop project with no saved
view preference opens on the Board (`ProjectDashboard.tsx:1752-1758` gains
that default), so "Create project" from the rail lands there too (audit F29).
If designation fails, the seat panel shows its error block and "Try again"
with the mandate still folded: the forced open at `OrchestratorPanel.tsx:902`
goes (audit F36).

### 3.5 Overview before any orchestrator exists

While no seat has ever been designated on this install (no active, pending or
revoked seat in the seat store), the Overview shows one band above the
columns, built from the Tour's band: the seat schematic, "Start with an
orchestrator", the one sentence, and the filled button "Create an
orchestrator". The button opens the guide at the first of Engines / Project /
Orchestrator that is not done. The band has no dismiss: it goes away when the
first seat exists, as the phone's invitation does. The zero-projects panel
(`OverviewBoard.tsx:196-227`) keeps its layout; its button opens the guide at
Project; today it opens the rail's form.

On the phone the same band sits above the tabs.

Mockups: `overview-band-1440.png`, `overview-band-1280.png`,
`overview-band-390.png`.

### 3.6 A project's board before its orchestrator, and just after

Desktop (`board-draft-1440.png`, `board-draft-1280.png`,
`board-draft-1280-uk.png`):

- The seat panel is expanded above the columns, as today, holding the plain
  draft (§3.7). It fits in about 330 px, so the four columns stay on screen
  at 1280 × 800.
- The columns' empty texts name the orchestrator: Inbox "No tasks yet / The
  orchestrator adds a task here for each thing you ask."; Assigned "Nothing in
  progress / A task moves here when the orchestrator starts an agent on it."
  Blocked and Done keep their copy. This is the project board's copy with or
  without a seat. It is true in both states, it is what the walk's stop 2
  shows on a board whose seat has just gone live, and a condition on the seat
  would buy nothing. The change is to the four strings
  `kanban.empty.{inbox,assigned}.{title,body}` in `en.ts:3182-3185` and
  `uk.ts:3083-3086` (the Assigned titles stay), which the desktop board
  (`KanbanBoard.tsx:2643-2644`) and the phone (`MobileKanban.tsx:509-510`)
  both read. The Overview has its own copy (`KanbanBoard.tsx:2061-2065`,
  `OverviewKanban.tsx:143-146`) and does not change.
- "+" in the top bar (New task, New conversation with an agent) is unchanged
  and stays where it is. It is secondary because nothing else on the screen
  points at it, and the draft says in one muted line where it is: "Rather do
  one thing by hand? + in the top bar adds a task or starts a single agent."
  This replaces the "One task? Spawn one agent…" footer (`en.ts:2271`).

Phone. The seat invitation stays the first row and the dock stays "Create an
orchestrator to talk to…". Two things change, both in slice 1:

- The empty Inbox's "New task" becomes a bordered button (`border-border
  bg-card text-secondary`, the look of the "nearest column" chip below it),
  and its label loses its own "+" (`mobile2.kanban.newTask`: "New task" /
  "Нова задача"), so the icon is the only plus. The empty Assigned's "Tell the
  orchestrator" stays filled, since it leads to the orchestrator. On a
  seatless board the only filled things left are the orchestrator's.
- The empty texts are the shared strings above.

A brand-new project still opens on its conversation list with the seat
invitation above it (§1.5); the guide's path never shows that screen, because
Create opens the board with the seat on it.

Renders, all real, from `c675693d0` at 390 in en and uk: today
`phone-board-today-new-project-390.png`,
`phone-board-today-seatless-with-conversations-390.png`,
`phone-board-today-seatless-empty-inbox-390.png`,
`phone-board-today-seat-just-created-390.png`; with the slice-1 change
applied, `phone-board-proposed-seatless-empty-inbox-390.png` and
`phone-board-proposed-seat-just-created-390.png`. The draft sheet
(`board-draft-390.png`) carries the §3.7 copy.

### 3.7 The draft in plain language

Top to bottom, desktop and phone alike:

1. Heading "Create the orchestrator for {project}".
2. The one sentence (as in §3.3).
3. A muted example line: "Once it runs, write to it here: "add a delete
   command to todo.py", "make the tests pass"."
4. One "Runs on" row: engine mark, "Claude · Opus 5.5 · high effort · account
   Main", "Change" (expands `AgentLaunchControls` in place), and "Works in
   ~/code/todo-cli" at the right. The draft's effort default follows the
   orchestrator role (`high`); today it is `ORCHESTRATOR_SPAWN_CONFIG.effort`
   (`low`).
5. Folded: "Its instructions (v25) (edit)". Never opened by an error.
6. The button "Create the orchestrator" (or "Sign in to Claude first", as in
   §3.3), and the by-hand line under it.

Removed: the MCP status line, the "issues 12 and 14 / review PR 30 / merges on
APPROVE / deploys on its own" intro, the "One task?" footer.

Mandate v25 (`prompt.ts`, version bump and new fingerprint in `prompt.test.ts`):

- Opening line: "You are this project's orchestrator in Delegatus — the agent
  that owns its board and runs its work through Delegatus's own HTTP API and
  MCP tools (the MCP server is registered under the key `viewer`). You never
  act outside them." No issue numbers.
- Greeting (`ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE`): "Ready in {project}." /
  "Tell me what you want done here. I'll turn it into tasks on the board, have
  agents build and review it, and report back. Nothing starts until you ask."
- Conveyor clause: "… -> merge bar -> this project's own release step, only
  when the operator has turned releases on for this project (in their message
  or as a standing line in your monitor note) -> cleanup."

The rest of the mandate is untouched.

### 3.8 The walk

Starts by itself once, the first time a seat on this install turns live,
when the onboarding marker is not an `existing-install` one and its new
`walk` field is null. Every stop has Skip; Skip or the last button writes
`walk: "skipped" | "done"`. The menu row "Interface walk" starts it again on
the current project.

| # | Anchor (desktop / phone) | Title | Body |
|---|---|---|---|
| 1 | seat composer / board dock | This is your orchestrator | Write to it here, like to a colleague: what you want done in this project. It plans the work and answers in this conversation. (phone: "Tap here to write to it, …") |
| 2 | kanban columns / phone tabs | Its work shows up on the board | Each request becomes a task card. The agents it starts, and the review of their work, appear on the card. The card moves to Done when the work is finished. |
| 3 | Needs you island / bar badge slot | "Needs you" counts what waits on you | A question, a plan to approve, a decision. Press it to jump there. Everything else runs without you: you watch and give it work. |

Stop 3's primary is "Give it the first task", which ends the walk and focuses
the seat composer (the phone opens the seat conversation). Under it: "Show
this again from the menu: Interface walk."

Mechanics: one `OnboardingWalk` component mounted beside `OnboardingHost`
(`Viewer.tsx:1637`) finds `[data-walk-anchor=…]`, draws the spotlight box and
places a 340 px popover (full width minus 24 px on the phone) below or above
the anchor, whichever fits. The spotlight box is clamped to the anchor's own
pane (on the desktop the board, right of the rail), so it never spills over
the rail. Before stop 1 it expands a collapsed seat
(`expandKanbanSeat`, the call `Viewer.tsx:611` makes) and switches the project
to the Board. The phone's badge is hidden at zero, so the shell renders the
badge slot empty-outlined while stop 3 is showing. An anchor still missing
(side placement collapsed to its rail, a window too short) centres the popover
without a spotlight. Escape skips; focus moves into the popover and back to the
composer at the end.

Mockups: `walk-1-1440.png`, `walk-1-1280.png`, `walk-1-1280-uk.png`,
`walk-1-390.png`, `walk-2-1440.png`, `walk-2-1280.png`, `walk-2-390.png`,
`walk-3-1440.png`, `walk-3-1280.png`, `walk-3-390.png`.

### 3.9 Re-entry from the menu

The rail menu (`ProjectRail.tsx:432-457`) and the phone's
`onboardingMobileMenuEntries` (`src/components/onboarding/menuEntries.tsx:12-18`)
gain one row, "Interface walk", between "Setup guide" and "Agent mapping". On
a project with a live seat it starts the walk there; anywhere else it opens
the guide at its first unfinished step.

Mockups: `menu-walk-1440.png`, `menu-walk-1280.png`, `menu-walk-390.png`.

## 4. Copy, en and uk

Every new or changed string. Existing keys keep their ids where the meaning
holds; the build adds the rest under `onboarding.*`, `orchPanel.*` and
`kanban.empty.*`.

| Where | EN | UK |
|---|---|---|
| Step names | Engines · Project · Orchestrator | Рушії · Проєкт · Оркестратор |
| Later group | Later, any time | Пізніше, будь-коли |
| Counter | Step {n} of 3 | Крок {n} з 3 |
| Step 2 heading | Pick the project it will work on | Виберіть проєкт, над яким він працюватиме |
| Step 2 lead | A project is a folder with your code, usually a git repository. Its orchestrator works there. | Проєкт — це тека з вашим кодом, зазвичай git-репозиторій. Його оркестратор працює там. |
| Step 2 group | Already on this computer | Уже є на цьому комп'ютері |
| Step 2 row | Open another folder / A folder the list does not show | Відкрити іншу теку / Теку, якої немає в списку |
| Step 2 count | {n} conversations | розмов: {n} |
| Step 3 heading | Create its orchestrator | Створіть його оркестратора |
| The one sentence | The orchestrator takes your requests, opens the tasks, runs the agents and reviews, and reports back. You watch and give it work. | Оркестратор приймає ваші запити, заводить задачі, запускає агентів і рев'ю та звітує вам. Ви спостерігаєте й даєте йому роботу. |
| Line 1 | You write to it in its conversation, like to a colleague: "add a delete command to todo.py". | Ви пишете йому в його розмові, як колезі: «додай команду видалення в todo.py». |
| Line 2 | Each request becomes a task on the board. It starts agents to do the work and a separate agent to review it. | Кожен запит стає задачею на дошці. Він запускає агентів, які виконують роботу, і окремого агента, який її перевіряє. |
| Line 3 | When it needs you (a question, a plan to approve), "Needs you" shows it. | Коли потрібні ви (питання, план на схвалення), це видно в «Чекають». |
| Fact rows | Project · Runs on · Change | Проєкт · Працює на · Змінити |
| Runs on value | Claude · Opus 5.5 · high effort · account Main | Claude · Opus 5.5 · зусилля high · акаунт Main |
| Cost note | It uses your Claude plan. Between steps it sleeps; it wakes every {check} minutes, when an agent finishes, or when you write. | Він використовує ваш план Claude. Між кроками спить і прокидається кожні {check} хв, коли агент завершив роботу або коли ви пишете. |
| Create | Create the orchestrator | Створити оркестратора |
| Read first | Read its instructions first | Спершу прочитати його інструкції |
| Signed out | {engine}'s account {label} is signed out, so the orchestrator cannot start yet. | Акаунт {label} у {engine} не ввійшов, тож оркестратор поки не може стартувати. |
| Sign in first | Sign in to {engine} first | Спершу увійдіть у {engine} |
| No engine | Connect Claude or Codex first. / Go to Engines | Спершу підключіть Claude або Codex. / До рушіїв |
| No project | Pick a project first. / Go to Project | Спершу виберіть проєкт. / До проєкту |
| Footer | Finish without it | Завершити без нього |
| Overview band | Start with an orchestrator / Create an orchestrator | Почніть з оркестратора / Створити оркестратора |
| Draft heading | Create the orchestrator for {project} | Створіть оркестратора для {project} |
| Draft example | Once it runs, write to it here: "add a delete command to todo.py", "make the tests pass". | Коли він запуститься, пишіть йому тут: «додай команду видалення в todo.py», «полагодь тести». |
| Draft mandate row | Its instructions (v{n}) (edit) | Його інструкції (v{n}) (редагувати) |
| Draft cwd | Works in {cwd} | Працює в {cwd} |
| By hand | Rather do one thing by hand? + in the top bar adds a task or starts a single agent. | Хочете зробити щось вручну? + на верхній панелі додає задачу або запускає одного агента. |
| By hand, phone | Rather do one thing by hand? + on the board adds a task or starts a single agent. | Хочете зробити щось вручну? + на дошці додає задачу або запускає одного агента. |
| Inbox, empty (project board) | No tasks yet / The orchestrator adds a task here for each thing you ask. | Задач ще немає / Оркестратор додає сюди задачу на кожне ваше прохання. |
| Assigned, empty (project board; title unchanged) | Nothing in progress / A task moves here when the orchestrator starts an agent on it. | Нічого в роботі / Задача переходить сюди, коли оркестратор запускає на ній агента. |
| Phone, empty Inbox button | New task (was "+ New task") | Нова задача (was "+ Нова задача") |
| Walk 1 | This is your orchestrator / Write to it here, like to a colleague: what you want done in this project. It plans the work and answers in this conversation. | Це ваш оркестратор / Пишіть йому тут, як колезі: що треба зробити в цьому проєкті. Він планує роботу й відповідає в цій розмові. |
| Walk 1, phone | Tap here to write to it, like to a colleague: … It plans the work and answers in its conversation. | Торкніться, щоб написати йому, як колезі: … Він планує роботу й відповідає у своїй розмові. |
| Walk 2 | Its work shows up on the board / Each request becomes a task card. The agents it starts, and the review of their work, appear on the card. The card moves to Done when the work is finished. | Його робота з'являється на дошці / Кожен запит стає карткою задачі. Агенти, яких він запускає, і перевірка їхньої роботи з'являються на картці. Коли все готово, картка переходить у «Готові». |
| Walk 3 | "Needs you" counts what waits on you / A question, a plan to approve, a decision. Press it to jump there. Everything else runs without you: you watch and give it work. | «Чекають» рахує, що чекає на вас / Питання, план на схвалення, рішення. Натисніть, щоб перейти туди. Решта працює без вас: ви спостерігаєте й даєте роботу. |
| Walk 3, phone | … a decision: a count appears here. Tap it to jump there. … | … рішення: тут з'являється лічильник. Торкніться, щоб перейти туди. … |
| Walk controls | {n} of 3 · Next · Skip · Give it the first task | {n} з 3 · Далі · Пропустити · Дати першу задачу |
| Walk footnote | Show this again from the menu: Interface walk. | Показати знову: меню → Екскурсія інтерфейсом. |
| Menu row | Interface walk | Екскурсія інтерфейсом |
| Seat greeting (mandate) | Ready in {project}. / Tell me what you want done here. I'll turn it into tasks on the board, have agents build and review it, and report back. Nothing starts until you ask. | (the seat answers in the operator's language; the mandate text is English) |

The uk renders at 1280 (`guide-orchestrator-1280-uk.png`,
`board-draft-1280-uk.png`, `walk-1-1280-uk.png`) and 390
(`guide-orchestrator-390-uk.png`) fit without truncation.

## 5. Dependencies: B1 and B2 ship first, as their own lanes

Both are bugs with a one-line cause, in files this design does not touch, and
each blocks a different half of the acceptance:

- **B2 blocks the acceptance outright.** The guide's whole point is Create on
  a project made one step earlier; today that press fails every time (§1.6).
  Fix: in `resolveOrchestratorCwd` (`seatCommand.ts:185`), after the request
  and the override, fall back to the manual project's recorded root
  (`projectCurationSnapshot().manualProjects`, `curation.ts:131`), then to
  `projectDirectoryFallbacks` (`src/lib/scanner/projectDirectories.ts:161`),
  before the conversation scan. That server fallback alone fixes the press, so
  B2 touches only `src/lib/orchestrator/seatCommand.ts` and
  `seatCommand.test.ts`. (Slice 2's guide also sends the project root it
  knows as the request's `cwd`; that is slice 2's own code and B2 does not
  depend on it.) Test: designation on a project created in the same test with
  no conversations resolves its root.
- **B1 blocks the npm-installed Claude user** at step 1, before any of this
  design is reached. Fix: accept the `/usr/bin/env node …/claude auth login
  --claudeai` argv shape in `isExpectedClaudeLoginArgv` (`claudeLogin.ts:91`),
  or re-read the cmdline for up to ~500 ms until exec settles; surface the
  reason code in the UI. Files: `src/lib/accounts/claudeLogin.ts` and its test.

Decision: **they ship first, separately, as #2167, and start now.** Neither
shares a file with the slices below, so slice 1 can be built in parallel;
slice 2's acceptance run waits for B2 on main. This lane's build does not
include them: folding a server-side seat fix and an account-fence fix into a
UI lane mixes review scopes, and B1 is a security fence whose change deserves
its own review. #2167 also carries B6 and B7 from the same audit; only B1 and
B2 block this design.

#2170 (a launch preflight shared by the orchestrator draft and the agent
launcher, whose button reads "Sign in to Claude first") overlaps §3.3's
signed-out state. It is not a blocker. If it lands first, slices 1 and 2 use
its preflight; if not, slice 1 builds the draft's half behind the same
function name and #2170 extends it to the agent launcher.

## 6. Build slices

Shared gates for each slice: `bunx tsc --noEmit --incremental false`, the
touched test files by path (never a directory sweep, AGENTS.md), `bun run build`
with an isolated config root, and the privacy gate from the merge base.
Rendered evidence goes through the existing drivers (AGENTS.md "Rendered
evidence"): cases added to `src/components/kanban/kanbanBoard.browser.test.tsx`
for the desktop board and to
`src/components/mobile/issue1671Evidence.browser.test.tsx` for the phone, PNGs
kept outside the repo, at 1440, 1280 and 390.

### Slice 1 — the plain draft and a board that points at it

Owns: `src/components/orchestrator/OrchestratorPanel.tsx`,
`src/components/mobile/MobileOrchestratorSheet.tsx`,
`src/lib/orchestrator/prompt.ts` and `prompt.test.ts` (v25),
`src/components/mobile/MobileKanban.tsx` (the empty Inbox's button,
`EmptyColumn` at `:486-521`),
`src/components/OverviewBoard.tsx` (the band),
`src/components/ProjectDashboard.tsx` (Board as the desktop default for a
project with no saved view), `src/lib/i18n/en.ts`, `src/lib/i18n/uk.ts`.
The empty-column copy is a string change only (§3.6), so `KanbanBoard.tsx`
is not touched. A reference patch of the phone half, against `c675693d0`, is
`src/phone-empty-inbox.patch` in the mockup folder. Plus one operator-state
step at merge: every active seat's monitor note gets the "Releases are on"
line (§2.4) before v25 is delivered to it.

Acceptance:
- The draft on desktop and phone shows none of: an issue number, "MCP",
  "deploy", "APPROVE", "lanes"; DOM tests assert it.
- A designation error leaves the mandate folded.
- A signed-out chosen account turns the button into "Sign in to {engine}
  first".
- With no seat on the install, the Overview shows the band; with one, it
  does not.
- A project created from the rail opens on its Board on desktop.
- On the phone, a DOM test in `MobileKanban.dom.test.tsx` renders a seatless
  project board with an empty Inbox and asserts that
  `[data-phone-kanban-empty-action="inbox"]` is not filled (no `bg-accent`)
  and reads "New task" with one plus, and that the empty Assigned action is
  still filled. `Viewer.overviewPhone.dom.test.tsx:331` keeps passing.
- Renders at 1440, 1280, 390 match `board-draft-*`, `overview-band-*`, and
  the phone board matches `phone-board-proposed-*` (the phone driver's case).

### Slice 2 — the three-step guide

Owns: `src/lib/onboarding/steps.ts`, `src/lib/onboarding/marker.ts` (new ids,
`walk` field; old ids ignored, new ones read null),
`src/app/api/onboarding/route.ts` if the patch parser needs the field,
`src/components/onboarding/OnboardingDialog.tsx`, a new `ProjectStep.tsx` and
`OrchestratorStep.tsx` in `src/components/onboarding/`, `TourStep.tsx` and
`TourStep*.dom.test.tsx` removed (the schematics stay),
`src/components/orchestrator/draftPrefill.ts` (`confirm`, `pendingConfirm`,
`takePendingSeatConfirm`, `launch.account`), the draft's
consumer of it in `OrchestratorPanel.tsx` and `MobileOrchestratorSheet.tsx`
(after slice 1 merges), `src/components/Viewer.tsx` (Board view on the
request).

Acceptance, the issue's own: a fresh isolated install reaches a running
orchestrator from the setup guide without touching "New task". Concretely, a
scratch `HOME`, `TMPDIR` and `XDG_CONFIG_HOME` under `/var/tmp`, an
OS-assigned port, and `src/lib/runtime/fixtures/packagedProvider.py` on `PATH`
as `claude` (it answers `auth status` as signed in and records delivered
messages, no network). The driver opens the Viewer, walks Engines → Project
(creating a folder through "Open another folder") → Orchestrator → Create,
and passes when `get_orchestrator` on that Viewer reports a live seat for the
new project and the stub's `provider-deliveries.jsonl` holds the v25 mandate.
No request in the run hits `/api/tasks` with a create. Screenshots of each
step at 1440, 1280 and 390. Requires B2 on main.

Also, DOM tests for the pending confirm: the guide confirms while the Overview
is showing and the draft mounts afterwards, and exactly one designation is
sent, on the requested account, after the account options load; a requested
account that turns out signed out sends none and shows "Sign in to Claude
first"; a pending confirm older than 60 s sends none.

### Slice 3 — the walk and its menu row

Owns: a new `src/components/onboarding/OnboardingWalk.tsx` and its DOM test,
`data-walk-anchor` attributes in `src/components/kanban/KanbanSeat.tsx`,
`src/components/kanban/KanbanBoard.tsx`, `src/components/attention/AttentionIsland.tsx`,
`src/components/mobile/MobileBoard.tsx`, `src/components/mobile/MobileKanban.tsx`
(after slice 1),
`src/components/mobile/MobileShell.tsx` (the empty badge slot during stop 3),
`src/components/ProjectRail.tsx` and `menuEntries.tsx` (the row),
`src/components/Viewer.tsx` (mount, after slice 2), i18n keys.

Acceptance:
- On the slice-2 run, the walk starts once when the seat turns live, and not
  again after reload; Skip on any stop writes `walk: "skipped"`.
- An `existing-install` marker never starts it by itself; the menu row does.
- Each stop's spotlight covers its anchor inside the viewport at 1440 × 900,
  1280 × 800 and 390 × 844, stays inside the anchor's pane (on the desktop
  its left edge is right of the rail), and the popover is fully on screen
  (measured in the browser case); a collapsed seat is expanded before stop 1.
- "Give it the first task" focuses the seat composer.

## 7. Mockups

In `~/Pictures/delegatus-review/orchestrator-first/`. Two kinds:

**Mockups** of the new screens. Source: `src/mock.html` and `src/screens.js`
there, styled by `src/app.css`, which is `c675693d0`'s `src/app/globals.css`
compiled with the repo's Tailwind 4 pipeline (tokens, utilities,
`kanbanBoard.css`) with the mockup folder added as a source. Class strings are copied from `OnboardingDialog`, `EnginesStep`,
`TourStep`, `OrchestratorPanel`, `MobileSeatCard`, `MobileBoardDock` and
`MobileOrchestratorSheet`; the rail, top bar and columns around them are
drawn to match the audit's screenshots. Rendered with headless Chrome through
`playwright-core` at 1440 × 900 and 1280 × 800 (desktop) and 390 × 844 at 2×
(phone). An in-page check for text overflow and off-screen boxes reported
nothing on the final set. `src/buildcss.mjs` and `src/render.mjs` there are the
two drivers; they expect a `git archive` of `c675693d0` with `node_modules`
beside them. `src/measure.mjs` reads the walk's spotlight boxes (walk-2 at
1280: left edge 252 px, rail 248 px).

**Real renders** of the phone board (`phone-board-today-*`,
`phone-board-proposed-*`), produced by the product's own phone evidence
harness (`serveEvidenceFixture` over `issue1671Evidence.fixture.tsx`) in a
scratch `git archive` of `c675693d0`, headless Chrome at 390 × 844, 2×. The
fixture gained four scenes (`src/phone-board-fixture.patch`): a new project
with nothing stored, a seatless project with conversations, a seatless
project whose only task is Done, and a project whose seat has just been
created. The driver is `src/phone-board-driver.browser.test.tsx`. The
`proposed` set is the same harness after `src/phone-empty-inbox.patch` (the
slice-1 phone change) was applied to that export. The phone mockups
(`walk-*-390`) draw the empty Inbox as that proposed render shows it.

| Screen | 1440 | 1280 | 390 | uk |
|---|---|---|---|---|
| Guide 1, Engines | `guide-engines-1440.png` | `guide-engines-1280.png` | (unchanged on phone) | |
| Guide 2, Project | `guide-project-1440.png` | `guide-project-1280.png` | `guide-project-390.png` | |
| Guide 2, no projects | `guide-project-empty-1440.png` | `guide-project-empty-1280.png` | `guide-project-empty-390.png` | |
| Guide 3, Orchestrator | `guide-orchestrator-1440.png` | `guide-orchestrator-1280.png` | `guide-orchestrator-390.png` | `guide-orchestrator-1280-uk.png`, `guide-orchestrator-390-uk.png` |
| Guide 3, account signed out | `guide-orchestrator-signin-1440.png` | `guide-orchestrator-signin-1280.png` | `guide-orchestrator-signin-390.png` | |
| Overview, no orchestrator | `overview-band-1440.png` | `overview-band-1280.png` | `overview-band-390.png` | |
| Project board, plain draft | `board-draft-1440.png` | `board-draft-1280.png` | `board-draft-390.png` (draft sheet) | `board-draft-1280-uk.png` |
| Phone, new project today (real) | | | `phone-board-today-new-project-390.png` | `…-390-uk.png` |
| Phone, seatless board with conversations today (real) | | | `phone-board-today-seatless-with-conversations-390.png` | `…-390-uk.png` |
| Phone, seatless board, empty Inbox: today / proposed (real) | | | `phone-board-today-seatless-empty-inbox-390.png` / `phone-board-proposed-seatless-empty-inbox-390.png` | `…-390-uk.png` each |
| Phone, seat just created: today / proposed (real) | | | `phone-board-today-seat-just-created-390.png` / `phone-board-proposed-seat-just-created-390.png` | `…-390-uk.png` each |
| Walk 1, talk here | `walk-1-1440.png` | `walk-1-1280.png` | `walk-1-390.png` | `walk-1-1280-uk.png` |
| Walk 2, the board | `walk-2-1440.png` | `walk-2-1280.png` | `walk-2-390.png` | |
| Walk 3, Needs you | `walk-3-1440.png` | `walk-3-1280.png` | `walk-3-390.png` | |
| Menu, Interface walk | `menu-walk-1440.png` | `menu-walk-1280.png` | `menu-walk-390.png` | |

## 8. Checked against the requirement

| The operator asked | Where |
|---|---|
| Put the accent on the orchestrator | §3.3 (the guide ends on it), §3.5 (Overview band), §3.6 (the draft first on a new board) |
| Offer creating the orchestrator first, as the phone does | §3.2–3.3, §3.5; phone patterns reused, §1.5, §3.6 |
| Walk the person through the interface | §3.8, three stops on the live UI |
| "It takes care of the tasks; you watch and give it work" | the one sentence (§3.3, §3.5, §3.7) and walk stop 3 |
| Issue 1: first offer after engines and a project, with one sentence | §3.3 |
| Issue 2: walk, skippable, from the menu | §3.8, §3.9 |
| Issue 3: New task / + Agent available, secondary | §3.6, desktop and phone (the phone's filled New task goes bordered) |
| Issue 4: guide ends by creating the project and orchestrator | §3.2–3.3 |
| Acceptance: isolated install to a running orchestrator without New task | slice 2 acceptance, §6 |
| Acceptance: 1440, 1280, 390 renders | §7, and each slice's evidence |
| Dependencies B1, B2 | §5 |
| Brief: no issue numbers, no MCP line, no auto-deploy, mandate folded | §3.7, §2.4, §2.5 |

## 9. Deferred — not currently justified

- **The Tour's four cards as a screen.** Their content is split into step 3
  and the walk. The pipeline card (build → review → verify, fail loops back)
  is not taught up front any more; the audit's suggestion to explain it on the
  first pipeline the orchestrator opens is the better place and is its own
  change.
- **A preflight on "+ Agent" and "New task"** (audit F37, B3). The requirement
  makes them secondary; only the orchestrator's own button gets the
  signed-out check here. The launcher half is #2170's (§5).
- **Opening a brand-new project's board on the phone** instead of its
  conversation list (§1.5). The seat invitation already leads that screen,
  and the guide's path never lands there.
- **Folder suggestions that find git repositories** (audit F28). The guide
  reuses the rail's picker as it is.
- **Reordering the "+" menu** to put the orchestrator first. Nothing asked for
  it, and the seat panel already sits above the board.
- **The Overview's four repeated empty texts** (audit F26). The band gives the
  next step; rewording the column states is polish outside this requirement.
- **A mandate for repositories without GitHub.** The conveyor still says
  "GitHub issue -> worktree lane" (`prompt.ts:331`); a newcomer's local-only
  repo will get a seat that looks for issues. Worth its own issue once someone
  runs a seat on such a repo.
- **Starter prompts** beyond the draft's example line (audit §4).
- **Teaching roles, cost and the phone after the first pipeline** (audit §4).

## 10. Prior work searched

`search_transcripts` for "orchestrator first onboarding desktop", "coach marks
guided walk interface tour after orchestrator created" and "cwd_unresolved
orchestrator new project", project-scoped and unscoped. The hits were the
seat's filing of this lane (the source of §0) and the onboarding slice-3
lanes, whose design (`docs/design/onboarding.md` §2.4) decided "no overlays on
the live UI, no coach marks". This design reverses that for the walk only,
because the operator now asks for a walk through the interface itself; the
guide keeps the rule. No earlier design of a walk or of a cwd fallback was
found.

## 11. Summary

The setup guide becomes three steps, Engines, Project and Orchestrator, and
ends by creating the orchestrator with one press. The press is a pending
confirm that the board's own draft takes once it has mounted and loaded its
options. Before any seat exists, the Overview carries one band that points
at the same path. A project board's empty columns say the orchestrator fills
them, on the desktop and on the phone, and the phone's filled "+ New task" goes
bordered, so the manual paths stay available and quiet. The draft loses its
jargon, its MCP line and its default releases, with a standing line that keeps
releases on for every seat already running. A three-stop walk over the live
interface follows the first seat and is reachable again from the menu. B1 and
B2 (#2167) ship first as their own lane. The build is three slices: the plain
draft and the boards, the guide, and the walk.
