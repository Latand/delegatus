# Delegatus user guide: outline and part-1 specification

Status: design for the guide's structure and its first four pages. Written
against `main` at `f5a767e4` (2026-10-14). Every `file:line` below was read at
that commit. This stage wrote only this file; it changed no product source.

Update: the pages planned in section 2 were written by the README
restructure, which moved the README's feature detail into the guide
(`docs/design/readme-restructure.md`). This outline records the plan as it was
written; the guide's own contents list is the current index.

## 0. Originating requirement

The install owner, 2026-10-14 05:01Z, in Ukrainian, sent through the verified
owner relay to the Delegatus project's orchestrator, in reply to one of its
progress reports. Verbatim:

> Підготуй новий реліз , рідмі, скрини туди, і почни розробку документації
> делегатуса

In English: "Prepare a new release, the README, screenshots for it, and start
developing Delegatus's documentation." The relay expanded the documentation
part as: "begin substantive Delegatus documentation (installation/quick start,
core concepts, operator workflows, links to existing technical
documentation)". The release, README and screenshots belong to the release
lane (task `6b060c34`); this lane is the documentation.

The pinned specification turns that into part 1 and its acceptance:

- `docs/guide/README.md`: the table of contents of the whole guide, every
  planned page listed, the unwritten ones marked as planned;
- installation and quick start, from nothing to a first agent and a first
  pipeline, for each install path the README, `docs/docker.md` and
  `docs/macos-newcomer.md` describe, verified against current code;
- core concepts, one short section each, with how they relate;
- everyday operator workflows;
- English, plain, for the operator; the technical documents are linked where
  a reader needs depth; images optional and synthetic only;
- every command, setting, tool and UI label named exists on main (a reviewer
  spot-checks at least twenty); nothing contradicts the README or the project
  instructions; no identities, handles, chat ids, real project names or home
  paths; the local privacy gate passes; the README links to `docs/guide/`, as
  one line near the top, said so in the PR body.

**Should this be built: yes.** The owner asked for it in so many words, and
the repository has no page that teaches a newcomer to run work through
Delegatus: the README describes features, and the technical documents
describe mechanisms, several of them out of date (section 7).

## 1. Decisions

1. **Four files in part 1.** `docs/guide/README.md`, `getting-started.md`,
   `concepts.md`, `workflows.md`. One long page was rejected because the
   workflows need their own anchors to be linked from the board's language
   later; one page per workflow was rejected because seven small files add
   navigation that seven sections of one page avoid. Installation and quick
   start share a page, because the quick start differs only in its first
   command per install path.
2. **Labels come from the English interface.** Every quoted UI label is the
   string in `src/lib/i18n/en.ts`, in bold, exactly as written there. The
   guide says once (in its README) that the Ukrainian interface has the same
   items in the same places.
3. **No model names, prices, version numbers or default models.** They change
   with each release (the 1.13.0 release lane is running in parallel). The
   guide names the place that decides them: **Roles: engine and model** in
   Settings, and the draft the orchestrator is created from. The two
   exceptions are fixed minimums the code enforces: Bun 1.4 or newer and the
   default port 8898.
4. **No new images.** A page may embed one of the existing synthetic vectors
   in `docs/media/readme/` by relative path (`../media/readme/board.svg`,
   `orchestrator.svg`, `pipeline.svg`, `card-menu.svg`, `accounts.svg`); their
   provenance is already recorded. A new raster in the tree would need a
   media manifest for the hosted privacy gate, and part 1 does not need one.
5. **Part-1 pages never link a page that does not exist.** Planned pages
   appear only in the guide's README, as plain text marked *(planned)*. A
   part-1 page that needs depth links the README section or the technical
   document that exists today.
6. **The README change is one line.** Insert it between the feature bullets
   and `<a id="run"></a>` (between `README.md:35` and `README.md:37`), where
   the release lane's text and picture edits are least likely to land:

   ```markdown
   New here? The [Delegatus guide](docs/guide/README.md) takes you from installation to your first pipeline.
   ```

   The PR body says the README change is that single line, so the release
   lane (task `6b060c34`) can merge around it.
7. **This outline stays in `docs/guide/`** as the plan for the remaining
   pages. The guide's README links it in its last line, for maintainers.

## 2. The table of contents of the whole guide

The guide's README lists these pages in this order. Part 1 is written by this
lane; the rest are *(planned)*. Each paragraph says what the page teaches and
what it rests on.

### Part 1: start and everyday use (this lane)

**Guide home (`docs/guide/README.md`).** Who the guide is for, the order to
read it in, the conventions (bold labels from the English interface, the
three ⋯ menus by name, phone differences inline), the full contents with
planned pages marked, and where the README and technical documents already
cover a subject. Rests on this outline and `README.md`.

**Installation and quick start (`getting-started.md`).** What a machine needs,
the five install paths and when each fits, starting Delegatus and opening the
page, the setup guide's steps, the optional machine check, the first agent
(the orchestrator) and the first pipeline, and what to do when something does
not start. Rests on `README.md:39-114`, `bin/cli.mjs:46-114`,
`bin/agent-binaries.mjs:48-49`, `src/lib/onboarding/steps.ts:15-17`,
`src/lib/i18n/en.ts:5427-5621`, `landing/site/copy.js:6-60`,
`docs/docker.md:1-35`, `docs/macos-newcomer.md`, `docker-compose.yml:125-134`.

**Core concepts (`concepts.md`).** Project, board and task, agent and
conversation, the orchestrator and its tick, pipeline and stage, the review
loop and its budget, the merge setting, accounts and limits, the worker
limit, learned rules, reports, and the voice gateway, one short section each,
then one section on how they fit together. Rests on the code anchors in
section 5 (C-rows) and on `README.md:116-477`.

**Everyday workflows (`workflows.md`).** Asking the orchestrator for work,
reading the board, answering a decision form, reviewing a prototype, watching
a pipeline, merging and deploying, and releases. Rests on the W-rows in
section 5 and on `README.md:142-387`.

### Part 2 and later: planned pages

**The orchestrator in depth (planned, `orchestrator.md`).** The standing
instructions and the tick panel (wake schedule, the panel text sent on every
wake, **Board maintenance**, **Auto-rotation**), rotating by hand and what the
successor receives, the report log and Telegram copies, bug reports from a
failed tool, and work for another project going to that project's
orchestrator. Rests on `src/lib/monitor/seatTickSettings.ts`,
`src/components/orchestrator/SeatTickBody.tsx`, `src/lib/orchestrator/prompt.ts`,
`docs/orchestrator.md` (rotation sections) and `README.md:142-209`.
`docs/orchestrator.md` is partly stale (section 7), so the page is written
from code, and links that document only for rotation.

**Pipelines in depth (planned, `pipelines.md`).** Reading the stage graph,
fail edges and their budgets, the three exhaustion behaviours, read-only
stages with declared outputs, switching a running stage's engine, model or
account, retry, skip and close, out-of-memory recovery, the merger batch, and
worktree cleanup. Rests on `src/lib/pipelines/types.ts:73-91`,
`src/lib/pipelines/limits.ts`, `src/lib/mcp/server.ts:3318-3323`,
`docs/pipelines.md` (contract and recovery), `docs/merge-batch.md`.

**Accounts, limits and roles (planned, `accounts-and-roles.md`).** Adding
Claude, Codex and Copilot accounts and compatible providers, the usage
windows, which accounts a project may use, what happens at a limit, and the
role table (**Roles: engine and model**, the setup guide's **Agents** step)
that decides which engine, model and effort each role runs on. Rests on
`src/components/onboarding/AgentMappingTable.tsx`, `src/lib/roles/defaults.ts`,
`src/lib/mcp/server.ts` (`account_project_binding`, `role_presets`) and
`README.md:389-454`.

**Memory: learned rules and shared memory (planned, `memory.md`).** How a
stage leaves or rewrites a rule, its three levels, the **Learned rules**
window (profile, **Summarize**, removal, **Return**, **Undo**), the curator,
and the separate shared memory (search across engines, memories added to your
messages, the OpenRouter key and its monthly cap). Rests on
`src/lib/memory/roleTypes.ts`, `src/components/roleMemory/LearnedRules.tsx`,
`docs/design/role-memory.md`, `docs/design/agent-memory.md`,
`README.md:363-377` and `README.md:415-427`.

**From your phone (planned, `phone.md`).** Turning on phone access, the phone
layout (tabs, holding a card, full-screen task, pipeline and conversation),
push notifications and the quiet attention notice, and which settings live in
the board's ⋯ menu on a phone. Rests on `README.md:456-550`,
`src/components/onboarding/PhoneStep.tsx`, `src/components/mobile/`.

**Voice (planned, `voice.md`).** Dictation backends, read aloud, the Codex
voice conversation, and Voice Delegatus in use: its two ways of talking, the
spend cap, what it can send to the orchestrator. Rests on `README.md:552-581`,
`docs/transcription.md`, `src/components/voiceCompanion/`.

**Keeping Delegatus running and up to date (planned, `operations.md`).** The
**Update** dialog and **Automatic updates** for checkout installs, updating a
packaged install, running as a user service with the OOM drop-in, and the
Docker production instance with `scripts/rebuild.sh`. Rests on
`README.md:81-114`, `README.md:935-1023`, `src/lib/selfUpdate/`,
`docs/docker.md`, `docs/RELEASING.md:1-30`.

**Where every setting lives (planned, `settings.md`).** One map of every
switch an operator can change: the sidebar's ⋯ menu (**Settings**, **Help and
learning**, **Updates**, **Team**, **Activity**), the board's ⋯ menu (pages
**Accounts**, **Merging and syncing**, **Orchestrator**, **Archive or
delete**, and **Learned rules**), the orchestrator's tick panel, and the
environment variables already tabled in the README (linked from there).
Rests on `src/components/headerMenu/HeaderMenu.tsx`,
`src/components/ProjectDashboard.tsx:2109-2150`,
`src/components/orchestrator/SeatTickBody.tsx`, `README.md:848-933`.

**Troubleshooting (planned, `troubleshooting.md`).** Reading a **Needs you**
item, a parked pipeline, a stopped merge, a signed-out account, an
out-of-memory stop, low disk, missing MCP tools in your own session, and a
busy port. Rests on `src/lib/i18n/en.ts` (`pipelineBlock.mergeReason.*`,
`needs.*`), `README.md:935-992`, `docs/design/needs-attention.md`.

### Already documented elsewhere: linked, no guide page planned

The guide's README lists these under "Elsewhere in the repository", each with
one line, because they already teach the operator and a guide page would only
copy them: the README's [Read any agent as a chat](interface.md#conversations),
[Telegram](telegram.md), [Team](team.md#team),
[Linked installs](team.md#linked-installs),
[External relay](telegram.md#external-relay),
[MCP server for agents](mcp.md),
[Configuration](configuration.md),
[Platform support](getting-started.md#platforms),
[Security](security-and-privacy.md#security) and
[What leaves your machine](security-and-privacy.md#what-leaves-your-machine); and the
technical documents `docs/docker.md`, `docs/RELEASING.md`,
`docs/pipelines.md`, `docs/merge-batch.md`, `docs/orchestrator.md`,
`docs/transcription.md`, `docs/privacy-publication.md` and
`docs/macos-newcomer.md`. (Paths in this paragraph are relative to
`docs/guide/`.)

## 3. Part-1 pages in detail

Each page below lists its headings in order, the facts it must state (with the
fact ids of section 5), the commands and settings to verify, and its links.
Sections stay short: two to six paragraphs or one short list each.

### 3.1 `docs/guide/README.md`: guide home

Headings:

1. `# Delegatus guide`. Two sentences: the guide teaches the person who runs
   Delegatus (the operator) to install it, give it work and steer that work;
   developers start at `ARCHITECTURE.md` and `CONTRIBUTING.md` instead.
2. `## Start here`. Read in order: Getting started, Core concepts, Everyday
   workflows. Each linked, one line each.
3. `## Contents`. Part 1 pages linked; planned pages as plain text with
   *(planned)* and one line each, in the order of section 2.
4. `## Elsewhere in the repository`. The README sections and technical
   documents from section 2's last paragraph, linked, one line each.
5. `## Conventions`. Bold text is a label as the English interface shows it;
   the Ukrainian interface (Settings → language) has the same items in the
   same places. "The sidebar's ⋯ menu", "the board's ⋯ menu" and "a card's ⋯"
   are the three menus. Where the phone differs, the page says so in the same
   paragraph. The guide follows `main`; a packaged release can lag behind it.
6. Last line: "For maintainers: [OUTLINE.md](OUTLINE.md) is the plan for the
   pages still marked planned."

Must not: repeat feature descriptions from the README; link a planned page.

### 3.2 `docs/guide/getting-started.md`: installation and quick start

Headings and what each states:

1. `# Getting started`. One paragraph: from nothing to an orchestrator
   working on your project, and a first pipeline that delivers its branch or pull request.
2. `## What you need` (G1, G2, G3, G21, G22, G23):
   - Bun 1.4 or newer, with its install command.
   - Claude Code or Codex, with both install commands; the orchestrator runs
     on one of them. GitHub Copilot is optional and runs single agents only.
   - `git` and a project folder: a pipeline initializes a safe plain folder
     with its first local commit before provisioning its worktree.
   - For pull requests and merging: a GitHub `origin` and the GitHub CLI
     (`gh`) signed in. Without them the merge setting says it needs a GitHub
     pull request, and a stopped merge names the signed-out `gh`.
   - Linux is the main platform; macOS works; native Windows runs Claude Code
     only, so use WSL 2 for the rest.
3. `## Choose how to install`. A table, one row per path: path, when it fits,
   the command, whether a `delegatus` command stays installed, how it updates.
   Then one subsection each:
   - `### Run the package` (G4): `bunx delegatus-cli`.
   - `### Keep a command installed` (G4): `bun add -g delegatus-cli`, which
     installs `delegatus`, its short alias `dlg`, and `delegatus-mcp`; `bun
     add -g` needs no root.
   - `### Let your coding agent install it` (G20): the website's install
     prompt for Claude Code or Codex. Say what it does, in its order: checks
     or installs Bun, checks or installs the agent CLI, installs the package,
     starts Delegatus in the background with `--no-open`, registers the MCP
     server under the name `viewer` for that agent, and returns the link. On
     native Windows it stops and asks for WSL 2. Link
     `docs/macos-newcomer.md` for the macOS specifics (Codex.app's bundled
     CLI, the separate Claude Code CLI).
   - `### Run from a clone` (G18): `bun install`, `bun run build`,
     `bun bin/cli.mjs`; build again after every pull; `bun dev` needs the
     runtime host started by hand. Link `README.md#from-a-clone`.
   - `### Docker` (G19): the test instance on port 8901 with the two commands
     from the README; the long-running production setup is the maintainer's
     and lives in `docs/docker.md`. Say that the packaged CLI already
     supervises its own runtime host, so pipelines do not need Docker.
4. `## Start Delegatus` (G5, G6, G7, G8, G9, G10): it listens on
   `http://127.0.0.1:8898/` and opens the browser when it can; `--port` and
   `--no-open`; the start output's missing-CLI message names both install
   commands; a busy port prints the next port to try; it starts two
   processes, the web app and the runtime host, and Ctrl+C stops both; it
   reads existing transcripts from `~/.claude`, `~/.codex` and `~/.copilot`,
   so earlier sessions appear as chats; the first start shows the install
   ping notice and how to turn it off.
5. `## The setup guide` (G11, G12, G13, G14, G15): its title is **Set up
   Delegatus** and its numbered steps are **Engines**, **Project**,
   **Telegram (optional)** and **Orchestrator**. Then, per step: the engine
   states (**Connected**, **Installed, signed out**, **Not installed**) and
   **Check again**; **Add compatible provider** for an Anthropic Messages
   compatible service (one sentence, link `README.md#quick-start`); the
   project choice (**Already on this computer**, **Open another folder**);
   the orchestrator draft (engine, model, effort and account it will run on,
   **Read its instructions first**, then **Create the orchestrator**). After
   it, the three-stop **Interface walk** (the orchestrator, the board, **Needs
   you**). Under **Later, any time** sit **Agents**, **Phone**, **Voice**,
   **Check** and **Relay service**. Reopen it from the sidebar's ⋯ menu →
   **Help and learning** → **Setup guide**.
6. `## Check that this machine works` (G16), optional: **Check** → **Run the
   check** runs one tiny pipeline in a scratch folder and wakes a test
   orchestrator, about two minutes, within a five-minute limit, touching none
   of your projects; name its five rows; a stopped row names what to fix.
7. `## Your first agent`: the orchestrator is it. Write to it in its chat like
   to a colleague (the setup guide's own example request). For a single agent
   without the orchestrator (G17): **+** in the board's header → **New
   conversation with an agent**; pick engine, model and reasoning in the
   composer's runtime pill and send. Copilot agents start only this way.
8. `## Your first pipeline`: ask the orchestrator for one small, well-defined
   change. Then describe what appears, in order: a task card, a pipeline row
   on it with its stages, the stages' conversations, the review round(s),
   and at the end the pull request left open with a report in **Reports**
   (the merge setting is off by default, C17). If it needs you, **Needs
   you** counts it and the **Decisions** tab holds the question. Close with:
   merge the pull request yourself, or turn on **Merge when the review
   passes** (link to the workflows page section).
9. `## If something does not start`: one line each for: no agent CLI found
   (G6); account signed out (Engines step); port busy (G7); only Copilot
   installed (G3); repository initialization refused (G21); no pull request or merge
   (G22). Point to the README's Configuration section for options and
   environment variables.
10. `## Next`: Core concepts; Everyday workflows; phone access
    (`README.md#phone-access`); the MCP server for your own Claude Code or
    Codex sessions (`README.md#mcp-server-for-agents`).

Commands to verify on this page (each must run or exist exactly as written):
`curl -fsSL https://bun.com/install | bash`,
`curl -fsSL https://claude.ai/install.sh | bash`,
`curl -fsSL https://chatgpt.com/codex/install.sh | sh`,
`bun add -g @github/copilot`, `bunx delegatus-cli`, `bun add -g delegatus-cli`,
`delegatus --help`, `bun install`, `bun run build`, `bun bin/cli.mjs`,
`bunx delegatus-cli --port <n>`, `--no-open`, the two Docker test commands.

Must not: name default models; repeat the README's Automatic updates or
environment-variable paragraphs; describe the Docker production bootstrap.

### 3.3 `docs/guide/concepts.md`: core concepts

Each section: what it is, what you see, what you control, and one line on how
it connects to the next. Order and facts:

1. `## Project` (C1): a folder with your code, usually a git repository; each
   project has its own board and at most one orchestrator. Work in a worktree
   of a repository groups under that repository's project, also after the
   worktree is deleted. The sidebar row shows waits, working agents and last
   activity; **Archive or delete** is in the board's ⋯ menu.
2. `## Board and tasks` (C2, C3, C4, C5): a task is the record, its card is
   how the board draws it. Four columns: **Inbox**, **In progress**,
   **Waiting**, **Done**. The state line says moving, waiting or stopped; a
   status note of up to 280 characters says what is happening now;
   priorities **High**, **Normal**, **Low**. **Needs you** counts what waits
   on you across all projects. The Overview board shows every project.
3. `## Agents and conversations` (C6): an agent is one Claude Code, Codex or
   GitHub Copilot session on one of your accounts; its conversation is its
   transcript, shown as a chat. Delegatus shows every conversation on the
   machine, also ones it did not start. Agents reach Delegatus through its
   MCP server, registered as `viewer`.
4. `## The orchestrator and its tick` (C7, C8, C9, C10, C11): one agent per
   project that you talk to; it turns requests into tasks and pipelines,
   watches them and reports. Its standing instructions come prewritten and
   you can edit them at creation. Delegatus wakes it on events (a pipeline
   event, a stage waiting on a decision, a task nobody started) and on a
   schedule, the tick: the chip in its header has four stops, off, every
   4 hours, every hour (the default) and every 10 minutes. The tick panel's
   text reaches it on every wake as your standing instructions. Say once
   that tools and technical documents call the orchestrator's position its
   "seat".
5. `## Pipelines and stages` (C12, C13, C16, C19): a pipeline runs one task
   through up to eight stages in its own git worktree and branch. A stage has
   a role (builder, reviewer, verifier, architect, visual critic and others)
   that sets engine, model, effort and whether it may change the repository.
   Each stage ends with a verdict: pass, fail or needs decision. The next
   stage receives everything the previous agent wrote. No stage deploys.
   **Finishes the task** moves the task to Done when the pipeline finishes,
   or when its pull request merges with merging on.
6. `## The review loop and its budget` (C14, C15): a review is a read-only
   reviewer stage whose fail edge goes to a fix stage that returns to it, so
   every round starts a fresh reviewer on the new head. The budget is fixed
   when the pipeline is created: three rounds unless the creator chose more,
   at most nine. N rounds are N reviews plus a fix of the last review's
   findings; after that fix the pipeline moves on with the fix marked as not
   re-reviewed, or, if it was created that way, waits on the fixed head with
   **Accept as is**. There is no extra review to ask for afterwards.
7. `## The merge setting` (C17, C18): **Merge when the review passes**, per
   project, off by default. Off: the pipeline ends with its pull request
   open and the orchestrator reports it ready. On: Delegatus merges reviewed
   pipelines one at a time per repository once required checks are green,
   updates a branch that fell behind, and starts a refresh on a conflict. It
   needs a GitHub pull request.
8. `## Accounts and limits` (C20): several accounts per engine, each with its
   own login; the sidebar's system block shows what is left of each weekly
   limit and **All windows** lists every window with its reset. A project
   can be limited to some accounts (board's ⋯ → **Accounts**). A stage that
   hits a limit moves to another allowed account of the same engine, or
   waits until one has room.
9. `## The worker limit` (C21): how many workers the orchestrator keeps
   running in one project, where a worker is a running pipeline or an agent
   the orchestrator started directly. The machine default is 3, settable
   from 1 to 64 in the sidebar's ⋯ menu → **Settings** → **Workers per
   project**; a project can have its own limit from the chip in the
   orchestrator's header (`workers N / M`). The orchestrator reads it at
   every wake. It limits the orchestrator's own starts; agents you start
   yourself are not refused by it.
10. `## Learned rules` (C22, C23): when a pipeline stage reports, its agent
    may leave one short rule for later agents, or rewrite a rule it was
    given, at one of three levels: its role in this project, every role in
    this project, or every project on this machine. Agents of that level
    start with those rules. Review and verification stages read none and
    leave none. The board's ⋯ → **Learned rules** shows and removes them.
    One sentence on shared memory as a separate feature, linked to the
    README.
11. `## Reports` (C24): what the orchestrator files: a stage that passed or
    failed, a review verdict, a blocked pipeline, a question, a status. They
    appear in the **Reports** log beside its chat and, if you chose a chat,
    in Telegram. **Bridge reports** on the board's ⋯ → **Orchestrator** page
    turns them off for a project, which also silences the voice. Reports are
    written in your interface language and carry no private details.
12. `## The voice gateway` (C25): **Voice Delegatus**, switched on in
    Settings with **Show the voice**, is a floating character you talk to.
    It answers about the board, reads the orchestrator's new reports once,
    and passes work you ask for to the project's orchestrator as your
    instruction; it asks you first only when the request is critical or
    unclear. It talks through the API with your OpenAI key and a monthly
    spend cap, or through a Codex subscription.
13. `## How they fit together`: a short numbered walk: you write to the
    orchestrator → it opens a task on the board → it starts a pipeline within
    the worker limit → stages run as agents on your accounts, each a
    conversation → a review loop spends its budget → the merge setting
    decides how the pipeline ends → the orchestrator files a report, and a
    decision only you can make reaches you as a form → stages leave learned
    rules for the next agents. A text figure is enough; no new image.

Settings and labels to verify on this page: the four column names, **Needs
you**, **Merge when the review passes**, **Merging and syncing**,
**Finishes the task**, **Accept as is**, **All windows**, **Accounts**,
**Workers per project**, `workers N / M`, **Learned rules**, **Reports**,
**Bridge reports**, **Orchestrator** (board's ⋯ page), **Voice Delegatus**,
**Show the voice**, the tick's four stops.

Must not: explain the HTTP API, stage JSON, onFail syntax, the legacy
`review-loop` stage kind or review flows.

### 3.4 `docs/guide/workflows.md`: everyday workflows

Each section: when you do it, the steps, what you see, the phone difference
in one sentence, and one link for depth.

1. `## Ask the orchestrator for work` (W1): open the project, write in the
   orchestrator's chat (typed or dictated); one request per message reads
   best; name issues or pull requests by number. **Ask** on a card puts that
   task above the composer as a chip, so the next message is about it. While
   it is busy, **Ask in parallel** sends a side question to a copy of it.
   Work for another project goes to that project's orchestrator. What comes
   back: a task card, a pipeline on it, a brief wire from the orchestrator to
   the card. Tell it standing rules in the tick panel's text, which it reads
   on every wake. Phone: the project's **Orchestrator** card opens the same
   chat (`src/components/mobile/MobileSeatCard.tsx`, `en.ts:4325-4328`);
   the writer checks its place on the screen before describing it.
2. `## Read the board` (W10, W11): columns and what each holds; the state
   line and its waiting reason; the status note; the pipeline row on a card;
   **Needs you** at the top and its filter (or the F key) that dims cards not
   waiting on you; a card's ⋯ (columns, rename, describe, attach, hide,
   priorities, **Appearance**, **Pipeline actions**, More); **Hidden** in the
   board's ⋯; **Images** on a card; Ctrl+Z and Ctrl+Shift+Z for your own
   board moves; the Overview for all projects; the sidebar's system block.
   Phone: columns become swipeable tabs, hold a card to move it.
3. `## Answer a decision form` (W2): a decision the orchestrator cannot make
   arrives as a form in the **Decisions** tab beside its chat and counts in
   **Needs you**. A form has one to seven questions (three to seven when it
   belongs to a task), each with two to six options and exactly one marked
   **recommended**; **Choose any** marks a question that takes several;
   **Other — write it below** takes your own answer in the comment. **Skip**
   takes the recommended answers. Your answer goes to the orchestrator once,
   as your own message, and the form shows **delivered**, **sending**, **not
   delivered** or **delivery unconfirmed**.
4. `## Review a prototype` (W3): a **Prototype** button on the card; numbered
   variants with names and descriptions; frames open enlarged, an original
   beside its change, video plays in place; choose one or several by number
   (number keys work), add a comment, **Save choice**; **None fits** asks what
   to redo and **Reject and redo** requests the next round; **Hide** takes a
   round off the waiting lists and can be undone; the saved state reads
   **Decision saved · delivered to the orchestrator**. **Send to Telegram
   again** resends a round. Phone: the review fills the screen, a tap opens
   a frame full screen.
5. `## Watch a pipeline` (W4, W9): the card's pipeline row (stage chain,
   state, pull request, issues it closes); open it for the stage graph beside
   each stage's conversation; the agent window lists open agents (Alt+J and
   Alt+K step, Esc closes, a header pill brings it back); in a running
   stage's conversation the runtime pill switches its model, effort, speed or
   account; when it stops, the card's state line says why and **Answer** or
   **Pipeline actions** (**Retry {stage}**, **Skip {stage}**, **Close the
   pipeline**, **Pause**, **Resume**, **Accept as is**) act on it; usage
   limits move a stage to another account by themselves. When to leave it
   alone: a running stage needs nothing from you.
6. `## Merge and deploy` (C17, C18, C19, W5, W7, W8):
   - Merging with the setting off: the report says the pull request is
     ready; merge it on GitHub or ask the orchestrator to.
   - With **Merge when the review passes** on: the row shows **waiting for
     checks**, **merging**, **merged** or **merge stopped**; a stopped merge
     names its reason and offers **Try the merge again** or **Leave the PR
     open**. Several reviewed pull requests can land as one batch through a
     merger stage; link `docs/merge-batch.md`.
   - Deploying your project: no pipeline stage deploys. Ask the orchestrator;
     only it or you can start a deployer agent. To make it routine, write
     what to do after a merge in the tick panel's text.
   - Updating Delegatus itself: the sidebar's ⋯ menu → **Updates** opens the
     **Update** dialog (**Check now**); it builds, verifies and switches the
     launcher, web server and runtime host together and restores the
     previous release if verification fails. **Automatic updates** (off by
     default) exist for checkout installs only; a packaged install updates
     through the dialog or `bunx delegatus-cli@latest`. A Docker production
     instance deploys with `scripts/rebuild.sh` (link `docs/docker.md`).
7. `## Releases` (W6): your project's releases are work like any other: ask
   the orchestrator, or put the rule in its standing instructions. The
   **Releases** switch in the tick panel exists only on the board of the
   Delegatus repository itself (for people who develop Delegatus with
   Delegatus): off by default, it prepares a release after 30 visible changes
   and a twelve-hour gap from a revision production served for six hours,
   and with **Ask before publishing** on it asks you first. Link
   `docs/RELEASING.md` for the procedure.

Labels to verify on this page: **Ask**, **Ask in parallel**, **Decisions**,
**Choose any**, **recommended**, **Skip**, **Prototype**, **Save choice**,
**None fits**, **Reject and redo**, **Hide**, **Send to Telegram again**,
**Pipeline actions**, **Retry {stage}**, **Skip {stage}**, **Close the
pipeline**, **Accept as is**, **Try the merge again**, **Leave the PR open**,
**Updates**, **Update**, **Check now**, **Automatic updates**, **Releases**,
**Ask before publishing**, **Images**, **Hidden**, **Appearance**.

Must not: teach the tick panel's maintenance and rotation (planned
orchestrator page), the merger procedure (linked), or Docker production.

## 4. Terms to use consistently

| Use | Meaning | Interface label or wire name | Avoid |
| --- | --- | --- | --- |
| you, the operator | the person who runs Delegatus | (none) | "the user" for that person |
| orchestrator | the agent you talk to about a project | **Orchestrator**; tools and documents say "seat" | manager, dock, seat (except to explain tool names once) |
| tick; wake | the orchestrator's wake schedule; one waking | tick chip, tick panel | heartbeat, cron |
| standing instructions | the tick panel's text sent on every wake, and the orchestrator's prewritten instructions | (panel text) | mandate (except when linking `docs/orchestrator.md`) |
| task; card | the record; its drawing on the board | columns **Inbox**, **In progress**, **Waiting**, **Done** | `assigned`, `blocked` (wire names) in prose |
| pipeline | one task's chain of stages in its own worktree | pipeline | lane (appears in some messages; explain once in concepts) |
| stage; attempt | one step of a pipeline; one run of it | stage | node, step |
| verdict | pass, fail, needs decision | `pass`, `fail`, `needs_decision` in tools | approve, reject |
| review round; review budget | one fresh review; the fixed number of rounds | (graph caption) | flow, review loop as a separate mechanism |
| fix stage | the builder pass that applies review findings | builder | fixer agent |
| merge setting | **Merge when the review passes** | Merging and syncing page | auto-merge |
| worker; worker limit | a running pipeline or an agent the orchestrator started; how many it keeps running | `workers N / M`, **Workers per project** | slot, lane count |
| account; usage limit; window | one engine login; its allowance; five-hour, weekly or monthly period | **Accounts**, **All windows** | quota, plan (except Copilot's plan) |
| role; role table | builder, reviewer and others; which engine, model and effort each runs on | **Roles: engine and model**, **Agent mapping** | preset (except in tool names) |
| learned rule; level | a short rule a stage leaves; role, project or machine | **Learned rules** | lesson (tool name `leave_lesson` only) |
| shared memory | engine memories searchable across Claude and Codex | **Shared memory** | memory (alone, ambiguous) |
| report; Reports log | what the orchestrator files | **Reports**, **Bridge reports** switch | bridge (alone) |
| decision form | a question set you answer by clicking | **Decisions** tab | questionnaire, poll |
| prototype review; variant; round | numbered screens to choose from | **Prototype** | mockup review |
| Needs you | what waits on you | **Needs you** | attention queue |
| setup guide | the first-run dialog | **Set up Delegatus** (title), **Setup guide** (menu) | onboarding, wizard |
| Voice Delegatus; voice gateway | the floating voice character that relays your instructions | **Voice Delegatus** | voice companion, voice relay |
| web app; runtime host | the two processes the command starts | Web runs / Runtime host runs | Viewer (developer term) |
| engine | Claude Code, Codex, GitHub Copilot | engine | model (when the engine is meant) |
| the sidebar's ⋯ menu; the board's ⋯ menu; a card's ⋯ | the three menus | ⋯ | header menu, kebab |
| pull request | spelled out on first use per page, then PR | PR | merge request |

## 5. Fact register

Every fact the part-1 pages state, with where it is decided. The writer cites
none of these anchors in the guide itself; they are for the writer's checks
and the reviewer's spot-checks (the acceptance asks for at least twenty).

### Getting started (G)

| Id | Fact | Source |
| --- | --- | --- |
| G1 | Bun 1.4 or newer; install command | `package.json:23`; `README.md:43-44`; `landing/site/copy.js:10-11` |
| G2 | Claude Code and Codex install commands | `bin/agent-binaries.mjs:49`; `README.md:46-47` |
| G3 | Copilot: `bun add -g @github/copilot`; runs single agents only; Delegatus's own missing-CLI message names a pinned version | `README.md:49,63`; `src/lib/i18n/en.ts:5516`; `src/lib/agent/cli.ts:122` |
| G4 | `bunx delegatus-cli`; `bun add -g delegatus-cli` gives `delegatus`, `dlg`, `delegatus-mcp` | `README.md:50,855-859`; `package.json:5-7` |
| G5 | Default `127.0.0.1:8898`; options `-p/--port`, `-H/--hostname`, `--tailscale`, `--no-open`, `--new-token`, `--new-operator-token`, `-v`, `-h` | `bin/cli.mjs:46-47,85-97` |
| G6 | Missing agent CLI start message with both install commands | `bin/agent-binaries.mjs:48-49` |
| G7 | Busy port message suggests the next port | `bin/cli.mjs:106` |
| G8 | Two processes; Ctrl+C stops both | `README.md:861-862`; `bin/cli.mjs:114` |
| G9 | Reads `~/.claude/projects`, `~/.codex/sessions`, `~/.copilot/session-state` | `bin/cli.mjs:110` |
| G10 | Install ping notice; Settings → **Install ping**; `DELEGATUS_TELEMETRY=0`, `DO_NOT_TRACK=1` | `README.md:1098-1104`; `src/lib/i18n/en.ts:72` |
| G11 | Setup guide steps and "Later" steps; reopened from **Help and learning** → **Setup guide** | `src/lib/onboarding/steps.ts:15-17`; `src/lib/i18n/en.ts:65,5427,5436-5443,5464,5489,5582-5583`; `src/components/headerMenu/HeaderMenu.tsx:381` |
| G12 | Engine states and **Check again** | `src/lib/i18n/en.ts:5506-5520` |
| G13 | Project step choices | `src/lib/i18n/en.ts:5467-5471` |
| G14 | Orchestrator step, **Read its instructions first**, **Create the orchestrator** | `src/lib/i18n/en.ts:3342,5473-5486` |
| G15 | **Interface walk**, three stops | `src/lib/i18n/en.ts:5491-5504` |
| G16 | **Run the check**: scratch pipeline, about two minutes, five-minute limit, five rows | `src/lib/i18n/en.ts:5591-5615` |
| G17 | **+** → **New task** / **New conversation with an agent** | `src/components/kanban/KanbanBoard.tsx:1409-1412`; `src/lib/i18n/en.ts:632,636` |
| G18 | Clone commands; build after pull; `bun dev` needs the runtime host | `README.md:71-79` |
| G19 | Docker test profile on 8901; production in `docs/docker.md` | `README.md:1050-1064`; `docker-compose.yml:125-134`; `docs/docker.md:5-14` |
| G20 | Website install prompt steps; Windows → WSL 2 | `landing/site/copy.js:6-60`; `landing/wrangler.jsonc:20` |
| G21 | A safe plain folder receives a local repository and first commit before provisioning | `src/lib/pipelines/initializeRepository.ts`; `docs/pipelines.md#create-and-inspect` |
| G22 | Merge needs a GitHub pull request and `gh` signed in | `src/lib/i18n/en.ts:589,2753` |
| G23 | Windows: Claude Code only natively; WSL 2 | `README.md:1025-1034` |

### Concepts (C)

| Id | Fact | Source |
| --- | --- | --- |
| C1 | Project is a folder, usually a git repository; worktrees group under their repository | `src/lib/i18n/en.ts:5468`; `AGENTS.md` (worktree grouping) |
| C2 | Columns **Inbox**, **In progress**, **Waiting**, **Done** (wire `inbox`, `assigned`, `blocked`, `done`) | `src/lib/i18n/en.ts:4485-4488` |
| C3 | Status note up to 280 characters | `src/lib/tasks/types.ts:282` |
| C4 | Priorities **High**, **Normal**, **Low** | `src/lib/i18n/en.ts:4778-4780` |
| C5 | **Needs you**; its Done section keeps seven days | `src/lib/i18n/en.ts:3511`; `README.md:234-240` |
| C6 | Every conversation on the machine shows as a chat | `README.md:478-486`; `bin/cli.mjs:110` |
| C7 | One orchestrator per project | `docs/orchestrator.md:59-60`; `README.md:121-122` |
| C8 | Tick stops off / 4 h / 1 h (default) / 10 min | `src/components/orchestrator/seatTickStops.ts:6-18`; `src/lib/monitor/seatTick.ts:118` |
| C9 | Tick panel text delivered in full on every wake | `src/lib/monitor/seatTickSettings.ts:38-41` |
| C10 | **Board maintenance** off by default, every 3 hours | `src/lib/monitor/seatTickSettings.ts:374-375` |
| C11 | **Auto-rotation** off by default, at 50% of context | `src/lib/monitor/seatTickSettings.ts:540-544`; `src/lib/orchestrator/contextPolicy.ts:20` |
| C12 | Up to eight stages; own worktree and branch | `src/lib/pipelines/limits.ts:14-18`; `docs/pipelines.md:99` |
| C13 | Verdicts pass, fail, needs decision; next stage receives the previous output | `src/lib/mcp/server.ts` (`stage_report`); `docs/pipelines.md:83`; `README.md:323-328` |
| C14 | Review = read-only reviewer with fail edge to a fix stage; default 3 rounds, max 9 | `src/lib/mcp/server.ts:3319-3320`; `src/lib/pipelines/limits.ts:20-21`; `src/lib/reviewHistory/limits.ts:3` |
| C15 | Exhaustion: advance (default), stop-after-fix, park; **One more round** always refused ("budget fixed"); **Accept as is** | `src/lib/pipelines/types.ts:73-91`; `src/components/kanban/stagesModel.ts:154`; `src/lib/i18n/en.ts:4937` |
| C16 | No deployer stage; a deployer agent only from the project's orchestrator or your own session | `README.md:319-321`; `src/lib/mcp/bindings.ts:1519-1533` |
| C17 | **Merge when the review passes** on **Merging and syncing**, off by default | `src/lib/i18n/en.ts:586-589,664`; `src/components/ProjectDashboard.tsx:2134-2136`; `README.md:339-354` |
| C18 | Merge states and stop reasons | `src/lib/i18n/en.ts:2722-2753` |
| C19 | **Finishes the task** | `src/lib/i18n/en.ts:2733`; `src/lib/mcp/server.ts:3318` |
| C20 | Accounts, windows, **All windows**, project **Accounts**, limit moves | `README.md:434-446`; `src/lib/i18n/en.ts:556,663,793`; `src/components/ProjectDashboard.tsx:2129-2131` |
| C21 | Worker limit default 3, range 1–64; what counts; read at every wake; Settings row | `src/lib/operator/workerLimit.ts:8-10`; `src/lib/orchestrator/workerCount.ts:33-52`; `src/lib/monitor/report.ts:227`; `src/lib/i18n/en.ts:7-23`; `src/components/headerMenu/HeaderMenu.tsx:140,327` |
| C22 | Learned rules: levels role, project, machine; reviews read none; board's ⋯ → **Learned rules** | `src/lib/memory/roleTypes.ts:34`; `README.md:363-377`; `src/lib/i18n/en.ts:6616`; `src/components/ProjectDashboard.tsx:2122-2125` |
| C23 | Shared memory is separate | `README.md:415-427`; `src/lib/i18n/en.ts:67` |
| C24 | Report classes; **Reports** log; **Bridge reports** switch on the **Orchestrator** page; off silences the voice | `src/lib/mcp/server.ts:3400-3403,4280`; `src/lib/i18n/en.ts:591-593,601-606,665`; `src/components/ProjectDashboard.tsx:2138-2140` |
| C25 | **Voice Delegatus**, **Show the voice**, its two backends; relays your instruction to the orchestrator | `src/lib/i18n/en.ts:2311-2313,2386-2388`; `src/lib/mcp/server.ts:3406`; `README.md:572-581` |

### Workflows (W)

| Id | Fact | Source |
| --- | --- | --- |
| W1 | **Ask** chip; **Ask in parallel** | `src/lib/i18n/en.ts:2093,2188`; `README.md:166-168,244-246` |
| W2 | Decision forms: 1–7 questions, 3–7 on a task, 2–6 options, one recommended; **Skip**; delivery states | `src/lib/prototypeReview/input.ts:15-25`; `src/lib/prototypeReview/store.ts:147`; `src/lib/prototypeReview/http.ts:122`; `src/lib/i18n/en.ts:1872-1906` |
| W3 | Prototype review labels | `src/lib/i18n/en.ts:1911-1915,1923,1952-1963,1990-1994,2006`; `README.md:259-278` |
| W4 | **Pipeline actions** and their labels | `src/lib/i18n/en.ts:4930-4939`; `src/components/kanban/stagesModel.ts:140-160` |
| W5 | **Updates** → **Update** dialog, **Check now**; **Automatic updates** off by default, unavailable on packaged installs | `src/lib/i18n/en.ts:62,5806,5830,5836`; `src/lib/selfUpdate/service.ts:376`; `README.md:81-114` |
| W6 | **Releases** only on the Delegatus repository's own board; 30 changes, 12 hours, six hours of production; **Ask before publishing** | `src/lib/monitor/seatTickSettingsAnswer.ts:266`; `src/lib/monitor/seatTickSources.ts:808-812`; `src/lib/i18n/en.ts:5365-5370`; `docs/RELEASING.md:177-181` |
| W7 | `deploy_exact_sha` deploys Delegatus only, never a project's code | `src/lib/mcp/server.ts:3361` |
| W8 | `scripts/rebuild.sh` for a Docker production instance | `docs/docker.md:105-125` |
| W9 | Agent window, Alt+J / Alt+K, Esc | `README.md:285-290` |
| W10 | **Needs you** filter and the F key | `README.md:241-242` |
| W11 | A card's ⋯ layout | `README.md:248-255`; `src/lib/i18n/en.ts:4732,4930` |

## 6. Checks the writer and the reviewer run

1. **Labels.** For every bold label on a page:
   `grep -n '": "<label>"' src/lib/i18n/en.ts` returns a line. Labels with a
   placeholder (**Retry {stage}**) are quoted with the placeholder replaced by
   a stage name in prose and checked with the placeholder in the grep.
2. **Commands.** `delegatus --help` (or `bun bin/cli.mjs --help` from a clone)
   prints every option the page names; the install commands match
   `README.md:43-49`.
3. **Links.** Every relative link resolves:

   ```bash
   for f in docs/guide/README.md docs/guide/getting-started.md docs/guide/concepts.md docs/guide/workflows.md; do grep -o '](\([^)#]*\)' "$f" | sed 's/](//' | grep -v '^http' | while read -r p; do [ -e "$(dirname "$f")/$p" ] || echo "$f: $p"; done; done
   ```

   It prints nothing when every link resolves. (Run on this outline it
   reports its own code blocks; that is expected.) The README's new line is
   checked with `test -e docs/guide/README.md`.

   README anchors are checked by eye against `grep -n '^##' README.md` after
   rebasing on main, because the release lane may rename headings.
4. **Privacy.** The local gate on the new files, with the fingerprints the
   hooks use (`--paths` must come last):

   ```bash
   LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE=scripts/privacy-known-value-fingerprints.json \
   LLV_PRIVACY_OCR_LANGUAGES=eng+ukr \
   bun scripts/privacy-publication-gate.ts --require-known-values \
     --paths docs/guide/README.md docs/guide/getting-started.md docs/guide/concepts.md docs/guide/workflows.md docs/guide/OUTLINE.md README.md
   ```

   The pre-commit and pre-push hooks run the same gate.
5. **Contradiction pass.** Read each page beside the README section it links;
   where the README and the code disagree, the page follows the code only if
   the README is silent on the point, and otherwise follows the README and
   reports the divergence in the PR body (none known that matters; see
   section 7).

No new script, test or CI job: a spot-check by the reviewer is the
acceptance, and a label checker would be machinery heavier than four pages.

## 7. Known divergences the writer must handle

- `docs/pipelines.md:3` and `docs/orchestrator.md:87` say "two to four
  stages"; the code allows eight (`src/lib/pipelines/limits.ts:18`) and the
  README says eight. The guide says up to eight and links `docs/pipelines.md`
  only for the stage contract, verdicts, worktree and recovery.
- `docs/orchestrator.md` describes an older surface: a "dock" opened by an
  **Orchestrator** button, merges "on APPROVE", review flows, and "nothing
  rotates by itself" (auto-rotation exists now, off by default). The guide
  follows the README's current wording (`README.md:142-189`) and links that
  document only for rotation.
- `docs/review-loop.md` documents the flow engine and its **Flow** chip, which
  the operator retired in favour of the pipeline graph
  (`docs/design/retire-flows.md`). The guide does not link it as the review
  mechanism.
- `docs/docker.md:372` says "Docker is the only install"; the README presents
  the packaged CLI as the way to try Delegatus and Docker as the maintainer's
  long-running setup (`README.md:1057-1064`). The guide follows the README.
- Copilot: the README's `bun add -g @github/copilot` and the missing-CLI
  message's pinned `@github/copilot@1.0.87` (`src/lib/agent/cli.ts:122`). The
  guide gives the README's command and says that Delegatus's own message names
  the exact version when it reports Copilot missing.
- `README.md:184-188` says **Releases** is "offered for a project whose
  production deploys Delegatus records"; the code offers it only on the
  Delegatus repository's own project (`seatTickSettingsAnswer.ts:266`). These
  agree in practice; the guide states the code's condition plainly.
- **Automatic updates** are unavailable on a packaged install
  (`src/lib/selfUpdate/service.ts:376`); the README does not say so. The guide
  says so in one sentence.

## 8. Writing rules for the pages

- Plain English, short paragraphs, second person. State each point directly.
- Each section opens with one sentence saying what it covers.
- Wrap prose near 80 columns, like the existing documents.
- No identities, handles, chat ids, account names, real project names, hosts
  or home paths. Use "your project", `todo.py` and similar invented names.
  Paths are repo-relative or start with `~`/`$HOME` as the README's do.
- No full UUIDs anywhere; an id, if one is ever needed, is an 8-character
  prefix.
- No model names or version numbers beyond Bun 1.4 and the port.
- Depth by link: one sentence of summary plus a link to the README section
  or technical document that has the depth.

## 9. Left for later pages

Deliberately outside part 1, each with the planned page that takes it:

- the tick panel's **Board maintenance**, **Auto-rotation**, rotating by
  hand, the orchestrator's instructions in depth, bug reports, cross-project
  messages → *The orchestrator in depth*;
- designing pipelines (stage roles, outputs, sandbox, fail-edge settings,
  runtime switching of the engine, the merger procedure, worktree cleanup,
  out-of-memory recovery) → *Pipelines in depth*;
- adding accounts and compatible providers, project account bindings, the
  role table and its costs → *Accounts, limits and roles*;
- the learned-rules window, the curator, shared memory and the OpenRouter key,
  **Asks you** → *Memory*;
- phone layout and push notifications → *From your phone*;
- dictation, read aloud, voice conversation, Voice Delegatus settings and
  spend → *Voice*;
- updates, user services, memory and CPU isolation, Docker production →
  *Keeping Delegatus running and up to date*;
- every switch and variable in one place → *Where every setting lives*;
- reading stops and failures → *Troubleshooting*;
- Telegram, team, linked installs, external relay, the MCP server, security
  and telemetry → the README sections already linked.

## 10. Deferred — not currently justified

- **Guide pages for Telegram, Team, Linked installs, External relay, the MCP
  server, Configuration, Security and telemetry.** The README sections teach
  them today; a guide page would copy them. Revisit if the README is cut down
  to an overview.
- **A Ukrainian translation of the guide.** The requirement asks for English;
  the interface already speaks Ukrainian.
- **Hosting on the landing site or a documentation generator.** GitHub renders
  Markdown; the landing site can include the pages later.
- **New screenshots or recorded media for the guide.** Synthetic README
  vectors cover part 1; new media needs its own provenance and manifests.
- **An automated label or link checker in CI.** Section 6's commands and the
  reviewer's spot-check meet the acceptance; a checker is a second mechanism
  for four pages.
- **Refreshing the stale technical documents** (section 7). Worth a separate
  documentation task; this lane changes only `docs/guide/` and one README
  line.
- **Developer documentation.** `ARCHITECTURE.md` and `CONTRIBUTING.md` serve
  developers; the guide is for the operator.
- **Documenting the scheme view, review flows and the HTTP API for
  operators.** Flows are retired; the HTTP API is in the technical documents
  for those who script Delegatus.

## 11. Validation against the requirement

The owner asked to "start developing Delegatus's documentation", and the relay
named installation and quick start, core concepts, operator workflows and
links to the technical documentation. Section 2 lays out the whole guide with
part 1 covering exactly those four subjects; section 3 gives each part-1 page
its headings and facts; section 5 anchors every fact in code for the
twenty-item spot-check; section 6 names the privacy gate run; decision 6 keeps
the README change to one line beside the release lane. Nothing here builds a
mechanism; the only artifacts are Markdown pages and one README line.
