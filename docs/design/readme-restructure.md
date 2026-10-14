# README restructure, guide additions and technical-doc corrections

Status: design for the docs builder. Written against `main` at `cfe9ae97b`
(2026-10-14); remote `main` was the same commit when this was written. Every
`file:line` below was read at that commit. This stage wrote only this file.

## 0. Originating requirement

The operator, 2026-10-14 about 08:55Z, to the Delegatus project's orchestrator,
verbatim (Ukrainian and Russian mixed):

> Так, заведи задачу: привести docs/pipelines, orchestrator, review-loop і
> docker у відповідність до коду й README. … А, и акцент нужно в README, кстати
> говоря, в README, я смотрю, очень раздутый, там типа сильно описывается то, что
> у нас есть, каждая деталь, типа «эта кнопка делает то», «эта кнопка делает
> это». Я думаю, что тоже есть смысл немножко почистить, чтобы было более
> опрятно. А все детали можно в документацию перекинуть. И чтобы, опять же,
> форматировано чтобы было красиво, и максимум картинок.

In English: "Open a task: bring docs/pipelines, orchestrator, review-loop and
docker in line with the code and the README. … And the focus should be on the
README: it is very bloated, it describes every detail we have, 'this button
does that', 'this button does this'. It makes sense to clean it up so it is
tidier. All the details can move into the documentation. Format it nicely,
with as many pictures as possible."

**Should this be built: yes.** The operator asked for both parts by name. The
README is 1121 lines, most of them control-level detail, and three of the four
technical documents describe surfaces that no longer exist (section 5).

## 1. Decisions

1. **Three layers, no duplication.** The README is the front page (what,
   why, install, a picture tour, links). `docs/guide/` holds every operator
   detail. `docs/pipelines.md`, `docs/orchestrator.md`, `docs/review-loop.md`
   and `docs/docker.md` stay technical (HTTP API, stage contract, seat and
   rotation contract, recovery, deployment). Operator walk-through text in
   `docs/orchestrator.md` moves to the guide, so the two never drift apart
   again.
2. **Hero: `docs/media/readme/pipeline.svg`.** It is the widest, most
   distinctive picture: a stage graph above three agents working side by side,
   which shows "delegate everything" at a glance. `orchestrator.svg` opens the
   tour, where the README explains talking to the orchestrator.
3. **Seven of the eight pictures in the README; `card-menu.svg` in the guide.**
   The card menu is exactly the control-level detail the operator wants out of
   the front page; it illustrates the guide's interface tour. Every picture
   also appears on the guide page that covers its subject. No picture is
   regenerated and none is added (section 8).
4. **Layout uses three constructs only**, all checked with GitHub's Markdown
   API (`gh api -X POST /markdown -f mode=gfm`) on this design: a Markdown
   image for full-width pictures; a GFM table whose cells hold
   `<img width="N">` for side-by-side pairs (GitHub keeps `width` and
   `align="center"`); the existing `<p align="center"><picture>…` logo. The
   npm page could not be fetched from here (a Cloudflare challenge answers
   scripted requests), so npm rendering is unverified; these are the plainest
   constructs that give a pair, and the current README already relies on
   relative image paths there. Open the npm page of the first release that
   carries the new README in a browser to confirm.
5. **Keep a heading wherever the tour has an equivalent section**, so its
   anchor survives: `quick-start`, `from-a-clone`, `docker`, `how-it-works`,
   `the-orchestrator`, `tasks-and-the-board`, `pipelines-and-review-loops`,
   `read-any-agent-as-a-chat`, `from-your-phone`, `security`,
   `what-leaves-your-machine`, `license`, plus the existing `<a id="run">`.
   Removed sections leave a bare `<a id>` (one line, see 3.1) so outside deep
   links land on the pointer to their new page. Every link inside the
   repository is still retargeted to the guide page (section 6).
6. **Thirteen new guide pages**, one per subject the README details today.
   Names follow `docs/guide/OUTLINE.md` section 2 where it planned the page.
   "Where every setting lives" and "Troubleshooting" stay planned.
7. **`docs/review-loop.md` is rewritten in place** around the pipeline review
   loop, with a short "Retired: review flows" section. The file name stays;
   three documents link it.
8. **No model names, prices or default models** in rewritten text: they change
   each release and are what made `docs/orchestrator.md` wrong. Text names the
   place that decides them (**Roles: engine and model**, `role_presets`,
   `src/lib/roles/defaults.ts`).
9. **Three README facts are corrected while they move** (3.3); they contradict
   code today.
10. **Fences hold.** No edit to `CHANGELOG.md`, the package version, `src/`,
    `landing/` or `docs/media/readme/`. No landing link targets a README
    section anchor (`landing/site/index.html:40` and `package.json:104` use
    GitHub's `#readme`, which every README has).

## 2. (a) Inventory of the current README

Line numbers are `README.md` at `cfe9ae97b`. "Guide" paths are under
`docs/guide/`. *Keep* means it stays in the README, *shorten* means a short
version stays and the rest moves, *move* means it leaves the README.

| Lines | Section / content | Verdict | Destination (page → heading) |
| --- | --- | --- | --- |
| 1-6 | Logo `<picture>` | keep | — |
| 8-18 | Title, tagline, pitch | keep | — |
| 20-35 | "What it adds", seven bullets | keep as `## Why Delegatus` | — |
| 37 | `<a id="run">` | keep | — |
| 39-54 | Quick start steps 1-5 (first sentence of 5) | keep | — |
| 55-60 | Compatible provider fields, OpenCode Go URL, token file | move | `accounts-and-roles.md` → Compatible providers |
| 61-65 | Step 6, Copilot note | keep; retarget link | `configuration.md` |
| 67-79 | From a clone | keep | — |
| 81-84 | **Updates** builds, verifies, rolls back | shorten to one line | `operations.md` → Updates |
| 86-91 | Recovery server, **Restart launcher**, packaged cache, Docker coordinator | move | `operations.md` → Updates → When the launcher needs a restart |
| 93-97 | Packaged releases before the updater | move | `operations.md` → Updates → Older packaged releases |
| 99-107 | **Automatic updates** | move (+ availability, 3.3) | `operations.md` → Automatic updates |
| 109-127 | "What it does" narrative | shorten into `## How it works` | `concepts.md` already holds the long form |
| 128 | `pipeline.svg` | keep as hero | also `pipelines.md` |
| 130-133 | "How it works" intro | drop (replaced) | — |
| 137-149 | Creating the orchestrator, draft, Interface walk | move | `orchestrator.md` → Create the orchestrator |
| 151-161 | Talking to it, wakes, screen moves, Decisions, Ask in parallel | shorten to two sentences | `orchestrator.md` → What it does for you (`workflows.md` keeps Ask and forms) |
| 162-165 | Board report on taking the seat | move | `orchestrator.md` → Each time it takes its seat |
| 166-176 | Board maintenance, panel text, tick chip, Auto-rotation, expired login | move | `orchestrator.md` → The tick panel; → Rotation |
| 177-182 | **Releases** switch | move (corrected, 3.3) | `orchestrator.md` → The tick panel → Releases (`workflows.md#releases` links it) |
| 184-191 | Workers per project, header chip, `role_presets` history | move | `orchestrator.md` → The worker limit (`concepts.md` keeps the definition) |
| 193-198 | Bug reports; work for another project | move | `orchestrator.md` → Bug reports; → Work for another project |
| 200-209 | Reports log, Telegram copies, **Bridge reports** | move | `orchestrator.md` → Reports |
| 211 | `orchestrator.svg` | keep in tour | also `orchestrator.md` |
| 215-229 | Columns, card anatomy, ordering, priority, timeline, **Images**, undo | shorten to two sentences | `interface.md` → The board |
| 231-245 | **Answer**, **Needs you** panel, Done section, filter and F | move | `interface.md` → Needs you |
| 246-248 | **Ask** chip | move | already `workflows.md#ask-the-orchestrator-for-work`; nothing new |
| 250-257 | Card ⋯ layout; column, conversation and board ⋯ | move | `interface.md` → A card's ⋯ menu |
| 259 | `card-menu.svg` | move | `interface.md` → A card's ⋯ menu |
| 261-274 | Prototype review | move | `workflows.md#review-a-prototype` (add the two facts in 4.2) |
| 276-281 | Reviews to the relay owner's Telegram, **Send to Telegram again** | move | `telegram.md` → External relay |
| 283-286 | Wires from the orchestrator | move | `interface.md` → The board |
| 288-293 | Agent window, Alt+J / Alt+K, Esc | move | `interface.md` → The agent window |
| 295-301 | Overview, header row, **Hidden** | move | `interface.md` → The board header and the Overview |
| 303-313 | Sidebar, system block, **All windows**, disk line | move | `interface.md` → The sidebar |
| 315 | `board.svg` | keep in tour | also `interface.md` |
| 319-334 | Stages, roles, verdicts, fail routing | shorten to two sentences | `pipelines.md` → Stages and roles; → Verdicts and fail edges (deployer corrected, 3.3) |
| 336-342 | Review rounds, last fix, **Accept as is** | shorten to one sentence | `pipelines.md` → Review rounds and the budget |
| 344-359 | Merge setting, checks, refresh, merger batch | shorten to one sentence | `pipelines.md` → Merging |
| 361-366 | **Finishes the task**, worktree sweep | move | `pipelines.md` → When a pipeline ends |
| 368-382 | Learned rules, curator, window | move | `memory.md` → Learned rules |
| 384-392 | Pipeline row, actions, links | move | `pipelines.md` → On the board |
| 396-412 | Starting agents, composer, `message.txt`, runtime pill, Stop, More actions, **Context**, service tier | move | `interface.md` → Start and talk to an agent |
| 414-418 | Supported Codex CLI versions | move | `accounts-and-roles.md` → Codex CLI versions |
| 420-432 | Shared memory | move | `memory.md` → Shared memory |
| 434-437 | Machine identity, GitHub App | move | `accounts-and-roles.md` → Who agents commit as |
| 439-453 | Accounts, windows, **Remove**, **Show Main again**, limit moves | shorten to one sentence | `accounts-and-roles.md` → Accounts and limits |
| 455-457 | **Activity** page | move | `interface.md` → Activity |
| 459 | `accounts.svg` | keep in tour | also `accounts-and-roles.md` |
| 463-479 | Phone layout, push, quiet notice | shorten to one sentence | `phone.md` → The phone layout |
| 481 | Phone pictures | keep in tour | also `phone.md` |
| 485-503 | Transcript sources, tool cards, preview gestures, token bands, search | shorten to two sentences | `interface.md` → Conversations |
| 505 | `conversation.svg` | keep in tour | also `interface.md` |
| 507-516 | working/done, questions, **Previous mine**, Retry/Discard | move | `interface.md` → Conversations |
| 520-555 | Phone access | move | `phone.md` → Phone access (tailnet-URL secret also in `security-and-privacy.md`) |
| 559-592 | Voice | move | `voice.md` |
| 596-621 | Telegram | move | `telegram.md` |
| 625-655 | Team | move | `team.md` → Team |
| 659-697 | Linked installs | move | `team.md` → Linked installs |
| 701-735 | External relay | move | `telegram.md` → External relay |
| 737-856 | MCP server, tools, `request_attention`, `clientRequestId` | move | `mcp.md` |
| 858-892 | The command, logs, old name, options table | move | `configuration.md` → The command |
| 894-910 | Files | move | `configuration.md` → Files |
| 912-916 | Language | move | `configuration.md` → Language |
| 918-941 | Environment variables, `_API_KEY` forwarding | move | `configuration.md` → Environment variables |
| 943-1000 | Agent memory, OOM drop-in, watchdog | move | `operations.md` → Agent memory |
| 1002-1035 | Agent CPU | move | `operations.md` → Agent CPU |
| 1037-1046 | Platform support | shorten to one line in Quick start | `getting-started.md` → Platforms (new) |
| 1048-1056 | Security | shorten to three lines | `security-and-privacy.md` → Security |
| 1058-1076 | Docker image, test instance | shorten | `docs/docker.md` already holds it |
| 1078-1082 | Launcher under a user service, retired units | move | `operations.md` → Running as a user service |
| 1084-1095 | More | keep as `## Documentation` | — |
| 1097-1099 | License | keep (moves last) | — |
| 1101-1121 | What leaves your machine | shorten to four lines | `security-and-privacy.md` → What leaves your machine |

## 3. (b) The new README

### 3.1 Outline

Target 200-260 lines (under a quarter of today's), hard ceiling 300. Prose
wraps near 80 columns as today.

```markdown
<p align="center">                          ← lines 1-6 unchanged
…
</p>

# Delegatus

**Delegate everything.**

<pitch: README.md:12-18, unchanged>

![A pipeline opened from its task: Build, Review and Verify stages, with Review's loop back to Build folded under it, and the builder's and the reviewer's conversations side by side](docs/media/readme/pipeline.svg)

New here? The [Delegatus guide](docs/guide/README.md) takes you from installation to your first pipeline.

## Why Delegatus

Delegatus runs on your own machine with your own agent accounts. What it adds:
<the seven bullets of README.md:22-35, unchanged>

<a id="run"></a>

## Quick start
<README.md:41-54 unchanged, step 5 ending:> Using a service that speaks the
Anthropic Messages API? See [Compatible providers](docs/guide/accounts-and-roles.md#compatible-providers).
6. Tell the orchestrator what you want done.

Linux is the main platform and macOS works; native Windows runs Claude Code
only, so use WSL 2 for the rest ([Platforms](docs/guide/getting-started.md#platforms)).
Copilot runs single agents; it cannot run the orchestrator. To keep a
`delegatus` command installed, change the port or set environment variables,
read [Configuration](docs/guide/configuration.md).

### From a clone
<README.md:69-79 unchanged>
To keep any install current, use **Updates** in the sidebar's ⋯ menu
([Updates](docs/guide/operations.md#updates)).

### Docker
<README.md:1060-1067: image, platforms, the two test-instance commands>
For a long-running service, [docs/docker.md](docs/docker.md) is the runbook.

## How it works
<6-8 lines from README.md:114-126: one orchestrator per project; it opens a
task and a pipeline; one agent builds, another reviews, the builder fixes; the
pipeline ends with a pull request, open or merged; it reports and asks only
what is yours to decide. Last line links [Core concepts](docs/guide/concepts.md).>

### The orchestrator
<2-3 sentences: write to it like a colleague; decisions reach you as a form
with a recommended answer in **Decisions** and under **Needs you**.>
![<alt of README.md:211>](docs/media/readme/orchestrator.svg)
More: [The orchestrator in depth](docs/guide/orchestrator.md).

### Tasks and the board
<2 sentences: four columns; a card says what moves, waits or needs you.>
![<alt of README.md:315>](docs/media/readme/board.svg)
More: [A tour of the interface](docs/guide/interface.md).

### Pipelines and review loops
<3 sentences: up to eight stages in its own worktree; a fresh reviewer every
round within a budget fixed at creation; merging is off until you turn on
**Merge when the review passes**. "The picture at the top shows one.">
More: [Pipelines in depth](docs/guide/pipelines.md).

<a id="agents-and-accounts"></a>

### Read any agent as a chat
<2 sentences: every Claude Code, Codex and Copilot conversation on the machine,
whoever started it, with diffs, command output and one search; several
accounts per engine with their limits.>

| Every conversation on your machine | Several accounts per engine |
| :---: | :---: |
| <img src="docs/media/readme/conversation.svg" width="375" alt="<alt of README.md:505>"> | <img src="docs/media/readme/accounts.svg" width="343" alt="<alt of README.md:459>"> |

More: [Conversations](docs/guide/interface.md#conversations) ·
[Accounts, limits and roles](docs/guide/accounts-and-roles.md).

<a id="phone-access"></a>

### From your phone
<1-2 sentences: tabs you swipe, hold a card to move it; open it on your phone
through your Tailscale network.>

| The board | A conversation |
| :---: | :---: |
| <img src="docs/media/readme/phone-board.svg" width="280" alt="<first alt of README.md:481>"> | <img src="docs/media/readme/phone-conversation.svg" width="280" alt="<second alt of README.md:481>"> |

More: [From your phone](docs/guide/phone.md).

<a id="voice"></a><a id="telegram"></a><a id="team"></a><a id="linked-installs"></a><a id="external-relay"></a><a id="mcp-server-for-agents"></a><a id="connect-an-orchestrator-through-mcp"></a><a id="configuration"></a><a id="platform-support"></a>

## Everything else
| Feature | What it gives you | Read |
| --- | --- | --- |
| Voice | Dictation, answers read aloud, voice conversations, Voice Delegatus | [Voice](docs/guide/voice.md) |
| Telegram | A bot for reports and files; read-only access to your own account | [Telegram](docs/guide/telegram.md) |
| External relay | A relay service's chats answered by this install | [External relay](docs/guide/telegram.md#external-relay) |
| Team | People sign in as themselves | [Team](docs/guide/team.md#team) |
| Linked installs | Two machines share one board | [Linked installs](docs/guide/team.md#linked-installs) |
| Memory | Learned rules for the next agents; memory shared by Claude and Codex | [Memory](docs/guide/memory.md) |
| MCP server | Your own Claude Code or Codex sessions get the same tools | [MCP server](docs/guide/mcp.md) |
| Updates and services | Updates, automatic updates, memory and CPU limits for agents | [Operations](docs/guide/operations.md) |
| Configuration | Command options, files, environment variables | [Configuration](docs/guide/configuration.md) |

## Documentation
<README.md:1084-1095 kept, plus: the guide index; docs/pipelines.md,
docs/orchestrator.md, docs/review-loop.md, docs/docker.md, docs/RELEASING.md,
docs/merge-batch.md, each with one line.>

## Security
Anyone who can reach Delegatus can run commands as you. It binds to
`127.0.0.1`; any other bind address, and `--tailscale`, turn on the access key.
Treat a phone-access link as a secret. [Security and privacy](docs/guide/security-and-privacy.md).

## What leaves your machine
<4 lines: one anonymous ping per UTC day to https://delegatus.org/api/ping with
exactly id, v, os, arch and kind; off in the sidebar's ⋯ menu → Settings →
Install ping, or DELEGATUS_TELEMETRY=0 / DO_NOT_TRACK=1; link to
security-and-privacy.md#what-leaves-your-machine.>

## License

MIT
```

### 3.2 Layout rules

- Full-width pictures are Markdown images; GitHub scales them to the column
  (it adds `max-width: 100%`, as the API render showed).
- Pairs are a two-column GFM table with centred header captions and
  `<img width>` cells. Widths give equal heights: the conversation picture is
  696×762 and the accounts picture 300×358.5 (their `viewBox` sizes), so 375
  and 343 pixels both draw about 410 pixels tall and fit GitHub's README column
  with cell padding (about 770 pixels). The phone pictures share one size; 280
  each.
- Alt text is the existing README caption of that picture, so nothing is
  rewritten and screen readers keep the same description.
- No HTML beyond the logo block, the image cells and the `<a id>` anchors.
  GitHub prefixes each `id` with `user-content-` and still resolves
  `#phone-access` (checked through the Markdown API).
- Every link in the README is relative (`docs/guide/…`), as the image links
  already are.

### 3.3 Facts corrected while they move

| README line | Today | Code | Write instead |
| --- | --- | --- | --- |
| 325-326 | "No stage can take the deployer role" | `src/lib/pipelines/roles.ts:110-113` admits `deployer` with `params.mode: "release"` in a run stage; `src/lib/roles/defaults.ts:279` "Release publication validates and asks before a tag; it never deploys production" | "No stage deploys. The deployer role is refused in a pipeline, except its release mode, which validates a release and asks before it pushes the tag." |
| 177-178 | **Releases** "is offered for a project whose production deploys Delegatus records" | `src/lib/monitor/seatTickSettingsAnswer.ts:266` (`available: viewerOwnProjectKeys().includes(project)`) | "offered only on the Delegatus repository's own project" (as `workflows.md:177-179` already says) |
| 99 | **Automatic updates** with no availability | `src/lib/selfUpdate/service.ts:371-377` (`packaged` for a package install) | "for a clone or a Docker runtime-host install; a packaged install updates through the dialog" |

## 4. (c) Guide additions

Each new page opens with one sentence saying what it covers, follows the
conventions in `docs/guide/README.md` (bold labels from the English interface,
the three ⋯ menus by name, phone differences inline) and links the technical
document for depth. Text moves verbatim unless 3.3 or section 5 corrects it.
Images use `../media/readme/<file>.svg`.

### 4.1 New pages

**`interface.md` — A tour of the interface.** Image: `board.svg` under The
board, `card-menu.svg` under A card's ⋯ menu, `conversation.svg` under
Conversations.

| Heading | From README |
| --- | --- |
| The board | 215-229, 283-286 |
| Needs you | 231-245 |
| A card's ⋯ menu | 250-257 |
| The board header and the Overview | 295-301 |
| The agent window | 288-293 |
| The sidebar | 303-313 |
| Conversations | 485-516 |
| Start and talk to an agent | 396-412 (the MCP sentence links `mcp.md`) |
| Activity | 455-457 |

**`orchestrator.md` — The orchestrator in depth.** Image: `orchestrator.svg`
after the first paragraph.

| Heading | From |
| --- | --- |
| Create the orchestrator | README 137-149; `docs/orchestrator.md:40-60` as corrected (O6-O8) |
| What it does for you | README 151-161 (screen moves, Decisions forms; link `workflows.md` for Ask and forms) |
| Each time it takes its seat | README 162-165 |
| The tick panel | README 166-172; `### Releases` ← 177-182 (3.3) |
| Rotation | README 172-176; operator half of `docs/orchestrator.md:147-170` (Rotate, prefilled draft, **Keep the incumbent's mandate**, what the successor receives), corrected per O13-O15 |
| The worker limit | README 184-191 (link `concepts.md#the-worker-limit`) |
| Reports | README 200-209 |
| Bug reports from a failed tool | README 193-197 |
| Work for another project | README 197-198 |
| When you do not need an orchestrator | `docs/orchestrator.md:235-245` corrected (O19) |

**`pipelines.md` — Pipelines in depth.** Image: `pipeline.svg` at the top.

| Heading | From README |
| --- | --- |
| Stages and roles | 322-326 (3.3) |
| Verdicts and fail edges | 328-334 |
| Review rounds and the budget | 336-342, 386-388 (link `../review-loop.md`) |
| On the board | 384-392 (link `workflows.md#watch-a-pipeline`) |
| Merging | 344-359 (link `../merge-batch.md`) |
| When a pipeline ends | 361-366 |

**`accounts-and-roles.md` — Accounts, limits and roles.** Image:
`accounts.svg` under Accounts and limits.

| Heading | From README |
| --- | --- |
| Accounts and limits | 439-451 |
| Compatible providers | 55-60, 452-453 |
| Roles | 811-815 (the **Roles: engine and model** half) and a link to `getting-started.md#if-only-one-engine-is-connected` |
| Codex CLI versions | 414-418 (versions: `src/lib/accounts/codexPinnedProtocol.ts:3-10`) |
| Who agents commit as | 434-437 |

**`memory.md` — Learned rules and shared memory.** Learned rules ← 368-382;
Shared memory ← 420-432. `concepts.md:164-167` then links here.

**`phone.md` — From your phone.** Images: the two phone pictures in a GFM
table, as in the README. The phone layout ← 463-479; Phone access ← 520-555.

**`voice.md` — Voice.** Dictation, Read aloud, Voice conversation, Voice
Delegatus ← 559-592, one heading per bullet.

**`operations.md` — Keeping Delegatus running and up to date.**

| Heading | From README |
| --- | --- |
| Updates | 81-97 (subsections: When the launcher needs a restart ← 86-91; Older packaged releases ← 93-97) |
| Automatic updates | 99-107 (3.3) |
| Running as a user service | 1078-1082 (link `../docker.md#moving-off-the-systemd-install`) |
| Agent memory | 943-1000 |
| Agent CPU | 1002-1035 |
| Docker | one paragraph and a link to `../docker.md` |

**`configuration.md` — Configuration: the command, files and environment
variables.** The command ← 863-892; Files ← 894-910; Language ← 912-916;
Environment variables ← 918-941. The memory and CPU variable tables stay in
`operations.md`; this page links them.

**`telegram.md` — Telegram and the chat relay.** The bot ← 599-608; Your own
account ← 609-614; When Telegram is down ← 616-621; External relay ← 701-735
and 276-281.

**`team.md` — Team and linked installs.** Team ← 625-655; Linked installs
← 659-697.

**`mcp.md` — The MCP server.** Register it for your own sessions ← 741-765;
Large reads run in Delegatus ← 767-772; The tools ← 774-844; Moving your view
and clearing a flag ← 846-851; Repeating a call ← 853-856.

**`security-and-privacy.md` — Security and privacy.** Security ← 1048-1056
and 554-555; What leaves your machine ← 1101-1121.

### 4.2 Edits to existing guide pages

- `docs/guide/README.md`: Contents lists the thirteen pages as written; only
  "Where every setting lives" and "Troubleshooting" stay *(planned)*.
  "Elsewhere in the repository" drops the ten README-anchor bullets
  (`README.md:55-70`, now guide pages) and keeps the technical documents,
  adding `docs/review-loop.md` and describing `docs/orchestrator.md` as "seat
  authority, mandate versions and rotation".
- `docs/guide/getting-started.md`: add `### Platforms` after the "What you
  need" list with README 1039-1046; retarget the links in section 6.
- `docs/guide/workflows.md#review-a-prototype`: add two facts from README
  261-274: a review is published after a visual critic passed it; before work
  with important open choices it can instead hold three to seven questions,
  answered in one message or skipped to the recommended answers.
  `#watch-a-pipeline` and `#merge-and-deploy` link `pipelines.md` and
  `operations.md#updates`.
- `docs/guide/concepts.md:164-167`: link `memory.md#shared-memory`.
- `docs/guide/OUTLINE.md`: one status line under the title ("Pages planned in
  section 2 were written by the README restructure;
  docs/design/readme-restructure.md") and the README links of lines 198-206
  retargeted (section 6).

## 5. (d) Contradictions in the four technical documents

Each row: the document's line and claim, the code that decides today, and
the correction. "Keep" rows were checked and need nothing.

### 5.1 `docs/pipelines.md`

| # | Line | Claim | Code at `cfe9ae97b` | Correction |
| --- | --- | --- | --- | --- |
| P1 | 1, 3 | "Linear agent pipelines"; "two to four agent stages"; "first slice supports `run` and `review-loop`"; "Every transition is linear and declared through `next`" | `src/lib/pipelines/limits.ts:14-19` (1-8 stages); `src/lib/pipelines/types.ts:87-91,116-120` (`onFail` edge; pass edge to any stage id, acyclic, merges allowed); `src/lib/orchestrator/prompt.ts:488`; `src/lib/pipelines/legacyReviewDefinition.ts:424-454` | Title `# Pipelines`. "A pipeline runs one to eight `run` stages in one dedicated git worktree. `next` is a stage's pass edge and `onFail` its fail edge; the pass graph is acyclic and cycles live only on fail edges. `review-loop` is a legacy kind kept for stored lanes." |
| P2 | 13-51 | Example spec "review uses the existing flow engine"; stage `review` of kind `review-loop`; `"model": "sonnet"` | same as P1; builder `mode` values `src/lib/roles/defaults.ts:228` | Replace the third stage with a read-only reviewer `run` stage carrying `"onFail": { "to": "fix", "maxRounds": 2 }` and a `fix` stage (`role: { roleId: "builder", params: { mode: "apply-fixes" } }`, `next: "review"`). Drop the model name. List the other request fields: `taskIds`, `finishesTask`, `autoStart`, `baseBranch`, `baseRef`, `publication`, `delivery` (`types.ts:1204-1224`). |
| P3 | 7-9 | GET list answers `{pipelines}`; GET one answers `{ok, pipeline}` | `src/app/api/pipelines/route.ts:40-52` (filters `project`, `state`, `includeClosed`, `limit`; unknown parameters refused); `src/app/api/pipelines/[id]/route.ts:66-69` (adds `revision`, `stageDigests`, `graphDigest`) | Add the filters and the three fields. |
| P4 | 53, 57 | "A review-loop requires an earlier run session"; review-loop findings use the flow's artifact | legacy only, `legacyReviewDefinition.ts:16-25` | Move both sentences under a `### Legacy review-loop stages` subsection (P13). |
| P5 | 61 | `role.roleId` names "one of the eight presets from issue #35" | `src/lib/pipelines/roles.ts:12-23` (ten ids); `roles.ts:110-113` (deployer only in release mode) | "one of ten pipeline roles: orchestrator, reviewer, verifier, builder, architect, cleaner, prod-auditor, deployer (release mode only), merger, visual-critic". |
| P6 | 63 | "The current Builder preset is Codex GPT-5.6-Sol with medium effort" | `src/lib/roles/defaults.ts:223-226` (another model, `high`) | Delete the sentence; "the Builder row of the role registry, shown under **Roles: engine and model** and read with `role_presets`". |
| P7 | 65-67 | UI lane: builder, then design critique with `onFail` to builder, then one code review | `src/lib/orchestrator/prompt.ts:567` (read-only brief stage, frontend builder, review loop, visual-critic stage last) | Rewrite the paragraph to that order. |
| P8 | 69 | Evidence that skips a surface "is REQUEST_CHANGES on its own" | `src/lib/roles/defaults.ts:26` ("is a finding on its own"); verdict words `src/lib/pipelines/prompts.ts:113` | "is a finding on its own"; cite `REVIEW_FRAME_RULES` as today. |
| P9 | 73, 83 | A stage completes "only when its finished turn ends with a fenced JSON block"; a terminal `REVIEW_READY` line is accepted; arbitrary trailing text is rejected | `src/lib/pipelines/prompts.ts:107-126` (`stage_report` is the channel, the fenced block a fallback); `src/lib/pipelines/verdict.ts:10,251-325` (last well-formed fenced block; conflicting statuses, `pass` with findings, or a disagreeing prose marker reject it; keys include `blocked`, `blockedReason`, `rankedFindings`); no `REVIEW_READY` handling outside the prompt that forbids it | Lead with `stage_report`; describe the fenced block as the fallback with those rejection rules; delete the `REVIEW_READY` and trailing-text sentences. |
| P10 | 87 | `stage_report` takes `{ verdict, findings, summary, stageId? }` | `src/lib/pipelines/prompts.ts:113-114` | Add `blocked?` and `blockedReason?` (fix stages that cannot proceed). |
| P11 | 93-95 | A review-loop stage attaches the run session to a review Flow; flow stops ridden out | legacy only; new review-loop stages are converted at creation (`legacyReviewDefinition.ts:424-454`); actions `preview-legacy-review`, `convert-legacy-review`, `revert-legacy-review` (`types.ts:1245-1247`) | Keep under `### Legacy review-loop stages`, opened by the conversion sentence and the three actions. |
| P12 | 99 | "Retry closes an embedded flow" | legacy only | "Retry closes a legacy stage's embedded flow, then …". |
| P13 | 111 | "The stage-kind validator and the injected prompt contract enforce" one-level composition | `src/lib/pipelines/prompts.ts:104`; `src/lib/mcp/bindings.ts:2199-2202,2229-2232`; `src/lib/agent/spawnAdmission.ts:36` | "Every stage's prompt forbids it, and `create_pipeline` refuses reviewer, verifier, maintainer, merger, issue-reporter and visual-critic callers." |
| P14 | 113-123 | `PATCH` "accepts one action:" followed by seven | `src/lib/pipelines/types.ts:1229-1260` (30 actions); `src/app/api/pipelines/[id]/route.ts:28,105` admits exactly that set | A table of all 30 grouped: draft and graph (`publish`, `takeover`, `start`, `update-draft`, `add-stage`, `remove-stage`, `reorder-stage`, `set-edge`, `set-src`, `delete`); run control (`pause`, `resume`, `retry-stage`, `skip-stage`, `override-stage`, `close`); decisions and review (`resolve-decision`, `continue-review` — always refused, budget fixed, `src/components/kanban/stagesModel.ts:154` — and `accept-head`); legacy (three, P11); tasks and links (`link-task`, `unlink-task`, `attach-link`, `detach-link`); board (`set-position`, `dismiss`, `undismiss`); merge (`retry-merge`). Keep the existing paragraphs of the seven already described. |
| P15 | 117 | `set-position` is written by "a drag" on the desktop board | no component sends it (`git grep '"set-position"' src/components` is empty); the desktop board is the kanban (`src/components/ProjectDashboard.tsx:1308-1313`) | "Accepted for compatibility; no current interface sends it." |
| P16 | 177-179 | Conditional verdict edges, DAGs and rich visual editing "remain later slices" | `types.ts:87-91,116-118` (fail edges, merging pass graph); `types.ts:1235-1238` (graph edits) | "Not supported: parallel stages, fan-out and voting panels; one stage runs at a time." |
| — | 99-109, 127-175, 181-195 | Worktree and branch naming, settlement, spawn deferral, cut recovery, survivors, out-of-memory | `src/lib/pipelines/store.ts:1780-1786` (`<repo>-pipeline-<id>`, `pipeline/<slug>-<id>`); `src/app/api/files/response.ts:809-823,1031` (`pipelinesError`) | Keep. Spot-checked where cited; the survivor and deferral paragraphs were not re-derived line by line. |

### 5.2 `docs/orchestrator.md`

Restructure: keep the technical parts (designation, mandate and versions,
rotation contract, tool and HTTP surfaces, where things live); move the
operator walk-through to `docs/guide/orchestrator.md` (4.1). Then:

| # | Line | Claim | Code at `cfe9ae97b` | Correction |
| --- | --- | --- | --- | --- |
| O1 | 3-8 | Work happens "in a dock beside the board"; it "runs a fresh reviewer each round, merges on APPROVE" | `src/components/kanban/KanbanSeat.tsx:38-44`, `src/components/orchestrator/OrchestratorPanel.tsx:185` (panel above the columns by default, or at the side); `src/lib/orchestrator/prompt.ts:468` (every accepted piece of work is a pipeline on its task); `prompt.ts:478` (merge setting governs); `prompt.ts:110-113` (the "merge on APPROVE" greeting ended at v25) | "You talk to it in the orchestrator panel above the board; it runs every accepted piece of work as a pipeline on its task, and merges follow the project's **Merge when the review passes** setting." |
| O2 | 10 | Image `media/orchestrator-dock.png` | file is absent (`ls docs/media/`) | `![…](media/readme/orchestrator.svg)` with the README's alt text. |
| O3 | 12-14, 32-38 | Press **Orchestrator** in the project header; the dock opens between the rail and the board; drag its right edge; width and open state remembered per project; phone uses an orchestrator row pinned in the conversation list | `src/components/ProjectBar.tsx:366-400` (the header **Orchestrator** toggle shows or hides the panel); `OrchestratorPanel.tsx:629-630` and `src/lib/i18n/en.ts:3300-3301` (**Dock at the side** / **Dock at the top**); `KanbanSeat.tsx:30-44` (height kept on this device, width per project); phone: `src/components/mobile/MobileSeatCard.tsx`, `en.ts:4325-4327` | Describe the toggle, the two placements and the phone's **Orchestrator** card; move the walk to the guide. |
| O4 | 20, 24 | Links `../README.md#run`, `../README.md#connect-an-orchestrator-through-mcp` | section 6 | `guide/getting-started.md`, `guide/mcp.md`. |
| O5 | 21-27 | Register the MCP server for the seat's engine first; the draft shows `viewer MCP: registered ✓` | `src/lib/agent/spawnPolicy.ts:94-117` (Delegatus gives every agent it launches the `viewer` server when the account registers none); README 744; no such string in `en.ts` | Delete the step. One sentence: agents Delegatus starts, the orchestrator included, get the tools on their own; your own sessions → `guide/mcp.md`. |
| O6 | 43-51 | The mandate carries "the deploy protocol"; "under the default mandate it deploys on its own unless you edit that out" | `prompt.ts:35-36,385-401,616-651` (v16 removed the Deploys section and delivery strips stored copies); `prompt.ts:477` (deploys go through `spawn_agent`) | Describe the mandate as `prompt.ts:422-506` has it (pipelines per task, stage contract, merge bar, reports, decision forms); "it deploys only when asked". |
| O7 | 52-54 | Launch controls of "the board's **Create → Agent** draft"; "The draft opens on Claude Opus at low effort" | `src/lib/orchestrator/prompt.ts:83-89`, `OrchestratorPanel.tsx:238-244` (the orchestrator role's own default, `high`); `src/components/ProjectBar.tsx:188` and `en.ts:632` (**+** → **New conversation with an agent**) | "The draft opens on the orchestrator role's default from the role table; change engine, model, effort or account before you create it." |
| O8 | 55 | **Confirm** designates the seat | `en.ts:3342` | **Create the orchestrator**. |
| O9 | 64-71 | Greeting "Tell me what to ship — I open lanes …" | `prompt.ts:116,132-134` | Quote the current two lines. |
| O10 | 78-89 | One lane per issue; verdicts `VERDICT: APPROVE \| REQUEST_CHANGES`; "the same machinery the **Flow** chip starts"; a pipeline "when the work wants declared stages: two to four stages" | `prompt.ts:468-473,484-488`; `src/lib/pipelines/limits.ts:18`; verdict words `src/lib/pipelines/prompts.ts:113` | Every piece of work is a pipeline on its task; a review is a read-only reviewer stage whose fail edge leads to a fix stage; verdicts pass, fail, needs_decision through `stage_report`; up to eight stages. Link `review-loop.md`. |
| O11 | 90-102 | "A PR is ready on an APPROVE verdict (or a completed lane) with green gates — `tsc` and the tests" | `prompt.ts:478` | "A PR is ready when reviews passed its final head or the budget's last fix passed, the required checks are green and its body is read." The rest of the paragraph (merger batch, held `merge.state`) matches `prompt.ts:478`; keep. |
| O12 | 103-115 | Merge wakes; finishing lanes | `src/lib/monitor/seatTickSources.ts:1573-1600` (merged lanes reach the seat as journal events); `prompt.ts:491-494` | Keep. Batching and expiry details were not re-derived. |
| O13 | 125-145 | Four surfaces incl. "the attention island in the corner" with `N` / `Shift-N` and `F` | `src/components/attention/AttentionIsland.tsx:20-34` (the header's **Needs you** control, "N waiting", opening the panel by project); `src/components/Viewer.tsx:1432-1440` (N and Shift+N walk the project on screen, F toggles the filter); `src/components/attention/AttentionToast.tsx` (toasts remain); forms in **Decisions** (README 157-159) | Name the panel badge, the toast, **Needs you** in the board header, and the card or the **Decisions** tab. Move to the guide; keep one sentence on report questions entering **Needs you** (`src/lib/attention/needsYouRead.ts:98-101`, two-hour expiry). |
| O14 | 152-155 | Two compactions, a transcript past 8 MB and a gone host each add a rotation reason | `src/lib/orchestrator/health.ts:382-384,409-427` (only the context threshold, `contextPolicy.ts:20` 50%, and a gone host) | Delete the compaction and transcript-size reasons. |
| O15 | 162 | Example `mandate v3, default v13` | format `en.ts:3335`; default is v53 (`prompt.ts:101`) | `mandate vN, default vM`. |
| O16 | 172-173 | "Nothing rotates by itself. Crossing the threshold changes what the dock says and nothing else." | `src/lib/monitor/seatTickSettings.ts:536-555` (**Auto-rotation**, off by default, 50-90%, default 50); `src/lib/monitor/seatAutoRotation.ts:113-118,238` (rotates at the next idle point); `src/lib/monitor/seatAuthRecovery.ts:18,307` and `seatTickController.ts:1667` (an expired login rotates the seat to another allowed account) | "The recommendation itself changes nothing (`health.ts:388-398`). Two things rotate a seat without you: **Auto-rotation** in the tick panel, when you switch it on, and an expired login, which moves the seat to another allowed account or pauses its wakes." |
| O17 | 175-177 | "The dock button is one way in" | `en.ts:3405` (**Rotate** in the panel) | "**Rotate** in the panel head is one way in". |
| O18 | 191-202 | Table: dock left of the board; board of conversation cards with lineage arrows; pipeline groups with a control hub; **Flow** chip and verdict deck; readiness strip; corner island; Telegram in the rail footer; pinned phone row | desktop board is the kanban (`ProjectDashboard.tsx:1308-1313`); no component renders `<SchemeBoard` (`git grep`); pipeline row on the task card (README 384-389); flows retired (`docs/design/retire-flows.md`); Telegram line in the sidebar's system block (README 596-597) | Rows: Orchestrator panel (above the board or at the side); Board (four columns of task cards); Pipelines (a row on the task card, opened as the stage graph); Needs you (header control, toasts, panel badge); Telegram (sidebar system block); Phone (**Orchestrator** card). Drop the Review flows row; add one line pointing at `review-loop.md#retired-review-flows`. |
| O19 | 204-233 | Model-per-job table (GPT-5.6 models, "create draft opens at low"); data-bar lanes hold merge until a round has no findings | `src/lib/roles/defaults.ts:171-327` (other models and efforts); `prompt.ts:519-572` (the role table is rendered into the mandate at delivery); fixed budget `prompt.ts:485-487` | Replace with: the role registry decides; **Roles: engine and model**, `role_presets`, `src/lib/roles/defaults.ts`; the mandate carries the current table. Delete the data-bar paragraph. Keep the effort scale sentence. |
| O20 | 235-245 | Spawn one agent from **Create → Agent**; "start a review loop when a change deserves one" | `en.ts:3340` ("+ in the top bar adds a task or starts a single agent"); flows retired | Move to the guide (4.1) with **+** → **New conversation with an agent**; reviews come from a pipeline. |
| O21 | 247-255 | review-loop "rounds, presets, the HTTP API, troubleshooting"; `media/README.md` for "every screenshot on this page" | after the rewrites | review-loop: "how a review round runs in a pipeline"; picture provenance: `media/readme/provenance.json`. Add `guide/orchestrator.md`. |

### 5.3 `docs/review-loop.md`

Today the whole page teaches review flows as the current mechanism. Code:

- The only entry point it names, the **Flow** chip of the scheme view, is in
  `src/components/scheme/nodes.tsx:1227-1238`, which only `SchemeBoard`
  renders, and no component renders `SchemeBoard`; the desktop has one view,
  the kanban (`src/components/ProjectDashboard.tsx:1308-1313`). The phone shows
  old flow rounds as history only (`src/components/mobile/MobileFocusView.tsx:437-449`).
- The mandate composes reviews as stages and forbids `review-loop`
  (`src/lib/orchestrator/prompt.ts:485,488`); a `review-loop` stage in a new
  pipeline is converted into a reviewer and a fix stage
  (`src/lib/pipelines/legacyReviewDefinition.ts:424-454`).
- `/api/flows` still creates and patches flows (`src/app/api/flows/route.ts:30-49`,
  `src/app/api/flows/[id]/route.ts:15-32`) and the MCP tools `list_flows`,
  `get_flow` and `flow_action` remain (`src/lib/mcp/server.ts:81,143`).
- Line 45's artifact path `~/.claude/viewer-state/flows/<id>/…` is stale: flow
  state resolves through `statePath` (`src/lib/flows/store.ts:25-27`) and the
  old directory was migrated (`src/lib/configDir.ts:100,199`).
- Lines 16-18 name seeded preset models; they come from the role registry
  (the page's own line 20-23 says so).

Rewrite, about 60 lines, keeping the file name:

1. `# Review loops`: a review loop is a read-only reviewer stage whose fail
   edge leads to a fix stage that returns to it; every round is a fresh
   reviewer on the new head (`types.ts:87-91`; `prompt.ts:485`).
2. `## The budget`: fixed at creation; three rounds unless chosen, at most
   nine (`src/lib/reviewHistory/limits.ts:3`; `limits.ts:20`); N rounds are N
   reviews and a fix of the last review's findings; **One more round** is
   always refused (`stagesModel.ts:154`).
3. `## When the budget is spent`: `onExhausted` `advance` (default),
   `stop-after-fix` (waits in `needs_review` with **Accept as is**), `park`
   (`types.ts:73-85`).
4. `## Defining one`: the JSON of P2.
5. `## Retired: review flows`: flows are retired
   (`docs/design/retire-flows.md`); nothing in the interface starts one; stored
   flows stay readable; `/api/flows` and the three MCP tools serve existing
   flows; artifacts live under the state directory's `flows/<id>/`;
   `.claude/skills/review-loop/` still describes flows for agents driving old
   ones.

### 5.4 `docs/docker.md`

Keep the headings `Run the published image`, `Production instance`,
`Bootstrap listener ownership`, `Moving off the systemd install` and `Test
instance`: other documents link them (section 6).

| # | Line | Claim | Code at `cfe9ae97b` | Correction |
| --- | --- | --- | --- | --- |
| D1 | 31 | "The Docker image pins Node 22 and builds the Next.js app" | `Dockerfile:3,6,18,79-81` (Node 22.16.0 base, Bun 1.4.0 installed, copied to `bun-container`); `Dockerfile:271`, `docker-compose.yml:54,107` (Viewer and runtime host run under `bun-container`) | "The image is built on Node 22 and pins Bun 1.4.0; the Viewer and the runtime host both run under that Bun, as `bun-container`." |
| D2 | 33 | Image runtimes list | `Dockerfile:62-81` | Add Bun 1.4.0 (`bun-container`) and util-linux. |
| D3 | 35 | Shims: `claude`, `codex`, `bun`, `uv`, `just`, `tmux`, `tailscale` | `Dockerfile:109-132` (also `copilot`, and a `docker` wrapper) | Add `copilot` from `$HOME/.bun/bin` and the `docker` wrapper. |
| D4 | 227, 333 | `…/agent-log-viewer/state`; `~/.config/agent-log-viewer/service.env` | `docker-compose.yml:20,68` default `~/.config/delegatus`; the page's own `DELEGATUS_CONFIG_DIR` (lines 44-47, 55) | `state="$DELEGATUS_CONFIG_DIR/state"`; `"$DELEGATUS_CONFIG_DIR/service.env"`. |
| D5 | 372-380 | "Docker is the only install"; after removing the units, "install with the production instance steps above" | README 63-79, 1069-1076 (the packaged CLI and a clone are the install paths; Docker is the maintainer's long-running service); README 1078-1082 | "The two systemd user units an earlier install set up … are retired. … Then start Delegatus any current way" (link `guide/getting-started.md#choose-how-to-install`) ", or follow Production instance" (link `#production-instance`) " for a long-running Docker service." The CLI notice that links here keeps its wording (section 8). |
| D6 | 422-438 | Mount `/home/user:/home/user`; runtime mounts `/tmp/tmux-1000`, `/tmp/claude-1000`; `LLV_UID`, `LLV_GID` | `docker-compose.yml:13,37-42` (`${HOME}:${HOME}`, `/var/tmp:/var/tmp:ro`, `DELEGATUS_UID`/`DELEGATUS_GID` preferred, `LLV_` accepted) | `$HOME:$HOME` (`/home/user` when `HOME` is unset); add `/var/tmp` read-only; name `DELEGATUS_UID` and `DELEGATUS_GID`. |
| D7 | 56 | `export LLV_DOCKER_GID=…` | `docker-compose.yml:15,71` (`DELEGATUS_DOCKER_GID` first) | `DELEGATUS_DOCKER_GID`, matching line 16. |
| D8 | 453-455 | The agent memory design has "the systemd drop-in needed by an existing host user-service install" | the drop-in moves from README 963-983 to `guide/operations.md` | Link `guide/operations.md#agent-memory`; keep the design link for reasoning. |
| D9 | 404-412 | Second test-instance recipe with a local `--build` | `docker-compose.yml:125-134` | Tidy, optional: one sentence under Test instance saying it builds the image locally, while Run the published image pulls it. |
| — | 3-29, 37-125, 127-180, 186-313, 315-368, 388-402, 440-452 | Image tags, bootstrap, `rebuild.sh`, host bootstrap, gateway, phone access, MCP over HTTP, tmux attach, watchdog | `.github/workflows/docker-image.yml:71-75`; `scripts/*` present; `src/runtime-host/viewerEntries.ts:13`; `src/lib/tmux.ts:904`; `src/lib/runtime/agentMemory.ts:42` (OOM score at least 500) | Keep. |

## 6. (e) Links that point at a README anchor that will move

Every one is retargeted, even where decision 5 keeps a legacy anchor.

| File:line | Today | New target |
| --- | --- | --- |
| `docs/guide/README.md:55` | `../../README.md#read-any-agent-as-a-chat` | `interface.md#conversations` |
| `docs/guide/README.md:57` | `#telegram` | `telegram.md` |
| `docs/guide/README.md:59` | `#team` | `team.md#team` |
| `docs/guide/README.md:60` | `#linked-installs` | `team.md#linked-installs` |
| `docs/guide/README.md:62` | `#external-relay` | `telegram.md#external-relay` |
| `docs/guide/README.md:64` | `#mcp-server-for-agents` | `mcp.md` |
| `docs/guide/README.md:66` | `#configuration` | `configuration.md` |
| `docs/guide/README.md:68` | `#platform-support` | `getting-started.md#platforms` |
| `docs/guide/README.md:69` | `#security` | `security-and-privacy.md#security` |
| `docs/guide/README.md:70` | `#what-leaves-your-machine` | `security-and-privacy.md#what-leaves-your-machine` |
| `docs/guide/concepts.md:166` | `#agents-and-accounts` | `memory.md#shared-memory` |
| `docs/guide/getting-started.md:51` | `#platform-support` | `#platforms` |
| `docs/guide/getting-started.md:123` | `#from-a-clone` ("has the rest") | `operations.md#updates` |
| `docs/guide/getting-started.md:136` | `#docker` (the two commands) | `../docker.md#run-the-published-image` |
| `docs/guide/getting-started.md:180` | `#what-leaves-your-machine` | `security-and-privacy.md#what-leaves-your-machine` |
| `docs/guide/getting-started.md:194` | `#quick-start` (provider fields) | `accounts-and-roles.md#compatible-providers` |
| `docs/guide/getting-started.md:359` | `#configuration` | `configuration.md` |
| `docs/guide/getting-started.md:366` | `#phone-access` | `phone.md#phone-access` |
| `docs/guide/getting-started.md:368` | `#mcp-server-for-agents` | `mcp.md` |
| `docs/guide/OUTLINE.md:198-206` | ten README anchors | the guide pages above |
| `docs/orchestrator.md:20` | `../README.md#run` | `guide/getting-started.md` |
| `docs/orchestrator.md:24` | `../README.md#connect-an-orchestrator-through-mcp` | `guide/mcp.md` |
| `README.md:65,410,478,889,1073` | in-file `#configuration`, `#mcp-server-for-agents`, `#phone-access`, `#quick-start` | gone with the rewrite; the new README's own links follow 3.1 |

Links into the four documents' anchors that must keep resolving:
`README.md:1081` and `guide/operations.md` → `docker.md#moving-off-the-systemd-install`;
`docs/RELEASING.md:27` → `docker.md#bootstrap-listener-ownership`;
`docs/guide/getting-started.md:142` and `docker.md:21` → `docker.md#production-instance`.
Code links the documents without anchors (`bin/legacySystemd.mjs:11`,
`src/lib/i18n/en.ts:5706,5993`); unaffected. Landing and `package.json` use
`#readme` only.

## 7. Checks the builder runs

1. **Length.** `wc -l README.md` prints at most 300.
2. **Nothing lost.** For each row of section 2 marked move or shorten, the
   named destination holds the row's facts; read `git show cfe9ae97b:README.md`
   beside the new pages.
3. **Links and anchors.** This one-off command (do not commit it) printed only
   the known broken `docs/orchestrator.md` image when run on `cfe9ae97b`; it
   must print nothing after the change:

   ```bash
   cat > "$TMPDIR/checklinks.ts" <<'EOF'
   import { readFileSync, existsSync } from "node:fs";
   import { dirname, resolve } from "node:path";
   const slug = (h: string) => h.trim().toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-");
   const anchors = (file: string) => {
     const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
     const seen = new Map<string, number>(); const out = new Set<string>();
     for (const m of text.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) { const s = slug(m[1]); const n = seen.get(s) ?? 0; seen.set(s, n + 1); out.add(n ? `${s}-${n}` : s); }
     for (const m of text.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) out.add(m[1]);
     return out;
   };
   let bad = 0;
   for (const file of process.argv.slice(2)) {
     const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
     for (const m of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(?:src|href)="([^"]+)"/g)) {
       const link = m[1] ?? m[2];
       if (/^(https?:|mailto:)/.test(link)) continue;
       const [path, frag] = link.split("#");
       const target = path ? resolve(dirname(file), path) : resolve(file);
       if (!existsSync(target)) { console.log(`${file}: missing ${link}`); bad++; continue; }
       if (frag && target.endsWith(".md") && !anchors(target).has(frag)) { console.log(`${file}: no anchor ${link}`); bad++; }
     }
   }
   process.exit(bad ? 1 : 0);
   EOF
   bun "$TMPDIR/checklinks.ts" README.md docs/guide/*.md docs/pipelines.md docs/orchestrator.md docs/review-loop.md docs/docker.md docs/RELEASING.md
   ```

4. **Rendering.** GitHub's renderer,
   `jq -n --rawfile t README.md '{text: $t, mode: "gfm", context: "Latand/delegatus"}' | gh api -X POST /markdown --input -`,
   returns every `<img>` with its `width` and both tables; open the branch's
   README on GitHub and look at it at desktop width and at 390 pixels.
5. **Labels.** Every bold label on a new page greps in `src/lib/i18n/en.ts`
   (`docs/guide/OUTLINE.md` section 6.1).
6. **Privacy.** From the merge base, the local gate on every changed file,
   with the fingerprints the hooks use (`--paths` last):

   ```bash
   LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE=scripts/privacy-known-value-fingerprints.json \
   LLV_PRIVACY_OCR_LANGUAGES=eng+ukr \
   bun scripts/privacy-publication-gate.ts --require-known-values \
     --paths $(git diff --name-only "$(git merge-base HEAD origin/main)" -- '*.md')
   ```

   The pre-commit and pre-push hooks run the same gate and `--check-commits`.
7. **Required checks.** A prose-only push skips types (`AGENTS.md`); the
   pre-push hook and CI must stay green.

## 8. Deferred — not currently justified

- **New pictures** for voice, Telegram, team, the MCP server or the interface
  tour. The operator asked for as many pictures as possible, and every
  existing one is used on both surfaces. A new capture means a new case in
  `scripts/capture-readme-media.ts`, which rewrites the provenance of all
  eight pictures that #2838 just refreshed and the fence forbids. Revisit as
  its own capture lane.
- **The older rasters in `docs/media/`** (`overview-board.png`,
  `review-loop.gif`, `spawn-agent.gif` and others). They show retired surfaces
  (the scheme view, flows); using them would put stale pictures back.
- **The CLI's own "Docker is the only install" notice**
  (`bin/legacySystemd.mjs:1,49,58`, asserted by `bin/legacySystemd.test.ts:41`
  and `bin/cli.exposure.integration.test.ts:318`). It is product code and
  tests, outside this documentation task; `docs/docker.md` stops repeating it.
  Worth a small follow-up.
- **The mandate's role-table line naming an "Opus review-loop"**
  (`src/lib/orchestrator/prompt.ts:567`) beside the rule forbidding
  `review-loop` (`prompt.ts:488`). `src/` is fenced for this lane.
- **`.claude/skills/review-loop/SKILL.md`** still teaches flows as current. An
  agent skill, outside the four documents; the rewritten `review-loop.md`
  names it as legacy.
- **"Where every setting lives" and "Troubleshooting" pages.** No README
  content needs them; they stay planned in the guide index.
- **A link checker in CI.** Section 7's one-off command covers this change; a
  committed checker is a second mechanism for a docs task.
- **A Ukrainian README or guide.** The requirement names neither.

## 9. Validation against the requirement

- "привести docs/pipelines, orchestrator, review-loop і docker у
  відповідність до коду й README": section 5 lists every contradiction found,
  each with the code that decides and the correction; the four known ones
  (P1, O1/O10/O16, 5.3, D5) are among them.
- "README … очень раздутый … каждая деталь … почистить, чтобы было более
  опрятно": section 3 cuts the README from 1121 lines to at most 300 and
  removes every button-level paragraph.
- "все детали можно в документацию перекинуть": every removed line has a named
  destination (section 2) on a guide page specified in section 4, and
  section 7.2 checks it.
- "форматировано чтобы было красиво, и максимум картинок": a hero, five tour
  pictures and two side-by-side pairs in the README, all eight pictures used
  across the guide, with layout verified through GitHub's renderer (decision 4,
  3.2).
- Nothing here adds a mechanism: the output is Markdown and one command run
  once.
