# Naming study: what the product is today, and what to call it

Status: material for the operator's choice (rebrand step 1). No product code
changes here. The icon waits for the chosen name.

## The requirement

The pinned outcome for this step, verbatim (the operator's own words were
spoken, and are paraphrased here per the repository's publication rules):

> Outcome (operator request 2026-09-22, paraphrased): the product outgrew its
> name. "Agent Log Viewer" / "Live Log Viewer" / "live-log-viewer-next" should
> give way to a new name that says what it is today: an agent-first
> orchestrator for development work, where the kanban board of tasks and the
> orchestrator seat drive everything through agents (pipelines, review rounds,
> deploys), with agent experience first. This step produces the material for
> the operator to choose a name; it changes no product code.

Source: the operator's message to the project's orchestrator seat on
2026-09-22, relayed into the board task for this lane. The same message asks
for a set of names to choose from together, a study of how the tool is really
used before naming, a rename of the repository and every mention afterwards,
and an icon later.

Every section below is checked against that paragraph: the name has to say
*orchestrator*, *board*, *seat* or *agents doing the work*, and the rename
plan has to keep existing installs working.

---

## 1. How the product is actually used

Sources: the Viewer MCP (`search_transcripts` with several phrasings in
English, Ukrainian and Russian, project-scoped and unscoped, then
`conversation_messages` around the hits; `list_tasks`, `get_task`,
`list_pipelines`), the README, `docs/orchestrator.md`, `docs/pipelines.md`,
`docs/design/onboarding.md` and the code. Everything is paraphrased. Other
projects are described by their kind only.

### What the board holds

- **About 1,600 tasks and 169 pipelines** on the board as of 2026-09-22, across
  at least six projects that each have an orchestrator seat (the seat-tick
  health cards show up for six of them). The product's own repository is the
  busiest one. The others include an ERP customization, a music-analysis
  research project and a chat-bot product.
- **Pipelines do much more than build and review code.** Stage names seen in
  the last three days: build, review, independent-review, design, critique,
  research, integrate, accept, fix, green (get the tests green), migrate,
  stage-e2e, seams-scan, study. Outside software, pipelines have invoiced a
  client, turned on a support mode for a customer after auditing the
  correspondence, and written a product viability and pricing study. The
  pipeline is the unit of *delegated work* in general.
- **Tasks are durable and pile up evidence.** A single board task often links
  several pipelines in sequence (one task links nine: a multi-slice storage
  migration; another links thirteen: a latency fix through several review
  rounds). "Successor lane" and "fix round N" appear constantly in pipeline
  titles, because work continues on the same card when a lane dies or a
  review fails.

### How the operator works

- **The operator mostly talks to the orchestrator seat, often by voice.**
  Messages are dictated, long, and mix Russian and Ukrainian with English
  terms. The operator states outcomes, approves or corrects a plan, sets
  policy (which model plays which role, which accounts to spend, how many
  agents may run at once), and asks for status. They rarely open a stage's
  conversation unless something looks wrong.
- **The operator decides; the seat does the rest.** Typical operator turns:
  approve a model/role matrix, choose Docker over systemd for installs, allow
  a quota-constrained account for a short test, ask what went into a deploy.
  Typical seat turns: file the cards, launch lanes, report back in the
  operator's language with card and lane references, and say what is waiting
  on a decision.
- **Phone and desktop both.** Phone access, push notifications for questions,
  and a phone layout exist because the operator checks and answers from a
  phone. Onboarding work this month centred on one-button phone access and
  dictation.
- **The product is presented publicly as an orchestrator.** A recent public
  workshop was framed around the orchestrator, the kanban board and managing
  agents; the new onboarding tour's first card is titled "An orchestrator for
  coding agents".

### How the orchestrator seats work

- **A seat runs several lanes at once and manages capacity itself.** On the day
  of this request the seat ran six lanes in parallel, raised its own
  concurrency cap from three to six while at least 4 GB of memory stayed free,
  watched weekly and five-hour quota per account, and planned to move new
  launches to another account if a window ran out.
- **It follows a conveyor.** Issue → task → pipeline (build → review, with a
  fresh reviewer each round) → merge → batched deploy → verification on
  production → cleanup. Deploys are batched on purpose ("one deploy instead of
  three"). Review rounds are capped, then the seat verifies the diff itself.
- **Agents are the heaviest users of the API.** Seats, builders and reviewers
  drive the board through the MCP tools (`create_pipeline`, `stage_report`,
  `send_message`, `deploy_exact_sha`, …). An August analysis of MCP receipts
  counted thousands of calls in its window. Agent experience first is
  observed practice.
- **Seats are woken, rotated and recovered.** The seat-tick mechanism wakes a
  seat on events; rotation hands a seat to a successor conversation; after a
  deploy cuts conversations, seats, builders and reviewers get a durable
  continuation. A large share of recent pipelines harden exactly this
  machinery.

### What this means for the name

- The **log viewer** is now a supporting surface: reading transcripts is how
  the operator audits agents, and how agents read each other
  (`conversation_messages`, `search_transcripts`). The product's centre is the
  **board** (durable tasks), the **seat** (a resident agent that runs the
  board), and **pipelines/lanes** (delegated, reviewed work).
- **Prior work found and reused:** an August product assessment lane
  (read through `conversation_messages`) reached the same conclusion. The
  first public post framed the product as a log viewer and got almost no
  response, and the people who would use it search for "parallel agents",
  "run multiple Claude Code" and "orchestrate". The same
  assessment listed the crowded neighbour set (Vibe Kanban, Superset, Claude
  Squad, Crystal/Nimbalyst, Conductor, Mozzie), which is why every candidate
  below is checked against agent-tool collisions specifically. No earlier
  naming study or rename plan existed (searches for rename/перейменувати/
  rebrand in this project returned only unrelated file renames).
- The repository already carries one rename: `src/lib/configDir.ts` resolves
  `~/.config/agent-log-viewer` first and falls back to the older
  `live-log-viewer` directory. The migration plan in §5 builds on that
  pattern.

---

## 2. Positioning

**One sentence.** For developers who run several coding agents at once,
*[Name]* is a local, agent-first orchestrator: you put work on a kanban board,
a resident orchestrator agent turns it into pipelines of builders and fresh
reviewers, and everything it does stays readable, interruptible and yours.

What makes it different from the neighbours (Conductor, Vibe Kanban,
Superset, Claude Squad, Nimbalyst):

- **Self-orchestrating.** A resident seat holds a mandate and runs the
  conveyor, so the operator writes outcomes and answers decisions. The
  neighbours give a human a nicer place to run agents by hand.
- **Board-driven.** Durable tasks carry the whole history (lanes, review
  rounds, successors) and are what both the operator and agents navigate.
- **Agent-first.** Every capability the operator has is an MCP tool an agent
  can call, with idempotent requests and receipts.
- **Reads everything already on the machine.** Existing Claude Code and Codex
  sessions appear with no setup.

### Brand attributes

1. **In command, calm.** The seat runs the work; the operator is interrupted
   only for decisions.
2. **Durable.** Work survives restarts, deploys, dead lanes and account limits.
3. **Transparent.** Every agent is a readable conversation you can open, stop
   or take over.
4. **Agent-native.** Written for agents to operate as much as for people.
5. **Local and owned.** Runs on your machine and accounts; nothing is hosted.

---

## 3. Candidates

### How the checks were run (2026-09-22)

| Check | Method | Reading |
| --- | --- | --- |
| npm | `npm view <name>` against the public registry | E404 = free |
| GitHub account | `gh api users/<name>` (answers for users and orgs) | 404 = free |
| GitHub repos | `gh api search/repositories?q=<name>+in:name`, top 3 by stars | count and the most relevant hit |
| Product collision | web search for the name as software/product, plus the 235-entry community list `awesome-agent-orchestrators` | named collisions only |
| .dev / .com | registry RDAP (Google registry for .dev, Verisign for .com); `curl` of the .com to see what it serves | 404 = unregistered |
| Trademark registers | **unverified**: USPTO, EUIPO and the Ukrainian register were not queried | — |

Every `.com` checked is registered, so the table says what the `.com` serves.
"Parked for sale" means it redirects to a domain broker and could be bought.
A registered `.com` in use elsewhere costs something and blocks nothing:
`.dev` plus a `get<name>.com` works. For the top five, every
`get<name>.com` is unregistered except `getyardmaster.com`.

**Trademark status is unverified for every name.** Before committing to the
winner, run a register search in classes 9 and 42 in the US, EU and Ukraine.

### The 20 candidates

Legend: ✅ free · ❌ taken · ⚠️ taken but weak/unrelated.

#### Descriptive

| # | Name | Idea | EN / UK reading | npm | GitHub | Product collision | .dev | .com | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **Seatboard** | The two things the product is built around: the seat, and the board it runs. | "SEAT-board"; «Сітборд», no meaning, easy to say | ✅ | ✅ no account, 0 repos | None found | ✅ | parked for sale | **Shortlist** |
| 2 | **Boardseat** | The idiom "a seat on the board": the one who sets direction. Also literally the board's seat. | natural English phrase; «Бордсіт», neutral | ✅ | ✅ no account; 15 tiny repos | BoardSeat Inc. (advisory-board networking, Canada) and Boardseats (board recruitment): same name, different field | ✅ | in use (403) | **Shortlist** |
| 3 | **Agentseat** | The seat is itself an agent; says "agents" plainly for search. | clear; «Ейджентсіт», long but fine | ✅ | ⚠️ org `agentseat` exists, 0 public repos | AgentSeat (12★): a Wayland tool giving an AI agent its own input in one GUI app | ✅ | parked for sale | **Shortlist** |
| 4 | **Laneboard** | A board of lanes (pipelines). | clear; «Лейнборд» | ✅ | ✅ no account; 2 tiny repos (one a tmux lane switcher) | "Lane", a small kanban app, sounds close | ✅ | in use (blank page) | Runner-up |
| 5 | Agentboard | Board of agents. | clear | ❌ AgentBoard CLI ("project management for agents and humans") | ❌ user taken; `gbasin/agentboard` 414★ (web GUI for AI agent TUIs), an agent benchmark 447★ | Direct | ❌ | ❌ | Reject |
| 6 | Orchboard | Orchestrator + board. | clear | ❌ "an agentic project board for Claude Code and Codex" | ❌ org taken | Direct competitor, same pitch | ✅ | ✅ | Reject |
| 7 | Helmboard | Steer from the board. | clear; «Гельмборд»; reads as Kubernetes Helm to developers | ✅ | ⚠️ org exists, 0 repos | helmboard.com sells "a human-interface device for vibe coders": same audience | ✅ | in use | Reject |

#### Metaphor

| # | Name | Idea | EN / UK reading | npm | GitHub | Product collision | .dev | .com | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| 8 | **Yardmaster** | The rail-yard master decides which train goes down which track, in what order, and holds them at signals: lanes, stages, decisions. | strong English word; «Ярдмайстер», майстер reads naturally | ✅ | ⚠️ user exists (1 repo); 33 repos, top 17★ | YARDMASTER lumber inventory software; YardMaster rail-automation product (other fields) | ❌ | in use | **Shortlist** |
| 9 | Conductor | Conducts an orchestra of agents. | classic; «Кондуктор» in Ukrainian means a tram/bus conductor | ❌ | ❌ `conductor-oss/conductor` 32k★ ("agentic workflow engine"), Netflix Conductor | conductor.build: YC-backed Mac app for parallel Claude Code/Codex agents | ❌ | ❌ | Reject |
| 10 | Bosun | The ship's bosun directs the crew; «Боцман» is well known in Ukrainian. | good in both | ❌ "Bosun Autonomous Engineering — manages AI agent executors" | ❌ `bosun-ai` org (agent tools), `bosun-monitor` 3.4k★ | Direct | ❌ | ❌ | Reject |
| 11 | Foreman | Site foreman / «бригадир» runs the crew. | clear | ❌ | ❌ `ddollar/foreman` 6.1k★, `theforeman` 2.9k★ | Two well-known dev tools | ❌ | ❌ | Reject |
| 12 | Pitwall | The race strategists' wall watching the cars. | clear in English; meaningless in Ukrainian | ❌ "local web app for reviewing Claude Code sessions" | ❌ user taken | Direct | ❌ | ❌ | Reject |
| 13 | Quarterdeck | Where the captain commands. | long | ❌ "a quarterdeck foundation for coding agents" | ❌ org taken; several Claude tray/control-deck repos | Direct | ❌ | ❌ | Reject |
| 14 | Flotilla | A fleet of small vessels; «Флотилія» is the same word in Ukrainian. | good in both | ❌ | ❌ org taken; `flotilla-os` 195★ | Stitch Fix's Flotilla job runner | ❌ | ❌ | Reject |
| 15 | Stagehand | Runs the stages. | clear | ❌ | ❌ `browserbase/stagehand` 25k★ | Major AI browser-automation SDK | ❌ | ❌ | Reject |

#### Ukrainian-rooted

| # | Name | Idea | EN / UK reading | npm | GitHub | Product collision | .dev | .com | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| 16 | **Vataha** | «Ватага» is a working crew or band; its leader is the «ватажок». The board is the crew, the seat is the leader. | "va-TA-ha", no English meaning; «Ватага», warm folk word. Risk: listeners may hear the Russian slang «вата» (a pejorative) | ✅ | ⚠️ user exists, 0 repos; 2 tiny repos | None found | ✅ | in use (placeholder page) | **Shortlist** |
| 17 | Hromada | «Громада»: a community acting together. | "hro-MA-da"; in Ukraine also the name of the basic administrative unit, so it reads as government | ✅ | ⚠️ org exists, 0 repos | Hromadske (Ukrainian media), a Canadian community portal | ❌ | ❌ | Weak |
| 18 | Toloka | «Толока»: neighbours doing a job together, a perfect meaning. | good in both | ✅ | ❌ `Toloka` org, 34 repos | Toloka AI, a data-labelling platform in the AI space | ❌ | ❌ | Reject |

#### Coined

| # | Name | Idea | EN / UK reading | npm | GitHub | Product collision | .dev | .com | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| 19 | Lanewright | A wright who builds lanes (like shipwright, wainwright). | fine in English; «Лейнрайт» is awkward in Ukrainian (silent w) | ✅ | ⚠️ user exists, 0 repos; 0 repos | A person's name online, no product | ✅ | personal site | Possible |
| 20 | Orkestr | «Оркестр» (orchestra) spelled as it sounds in Ukrainian. | good in both | ❌ "EU-hosted sandbox VMs for AI agents" SDK | ❌ user taken; Azure "Orkestra" | Direct (agent space) | ❌ | ❌ | Reject |

### Also checked and dropped (same method)

- **Taken by an AI-agent or dev-orchestration tool:** agentyard (npm: an MCP
  orchestrator for coding-agent sessions), taskyard (npm: an agent-first todo
  CLI), taskhelm (npm: a parallel git-worktree workbench), signalbox (repo:
  jump to any agent session), loopwright (repo: flight recorder for agent
  loops), agenthelm (repos: agent orchestration, agent memory), agentry,
  crewboard (repo: a PM agent on GitHub Projects), deckboss (repo: an "agent
  edge OS"), switchyard (NVIDIA LLM routing), taskwright, tutti.
- **Taken in other fields:** wheelhouse, quartermaster, orchestrion (DataDog),
  otaman (placeholder package), muster, drover, valka, robota, downbeat, kish,
  conveyor, orcha, coxswain, roundhouse, lanesmith.
- **Free on npm but weak as a brand:** crewseat, seatrunner, seatlane,
  yardboss, lanemaster, lanekeeper, boardwright, taskwarden, brygada, kapella,
  bandura, hetman.

**What the checks say about the space.** Almost every English word for
"someone who directs a crew" (conductor, foreman, bosun, quarterdeck, helm,
pitwall, signalbox, stagehand) is already an AI-agent tool. The free space is
in compounds built from this product's own nouns (seat, board, lane) and in
words the neighbours don't use.

---

## 4. Top 5

Ranked by: says what the product is (seat, board, orchestration) · free where
it matters (npm, `.dev`, GitHub account) · no collision in agent tools ·
reads well in English and Ukrainian · works as a CLI and env prefix.

1. **Seatboard.** The only candidate free on npm, GitHub and `.dev` with no
   product namesake anywhere; `seatboard.com` is for sale. It names both
   things the product is built around, so the tagline only has to add
   "agent orchestrator". Weakness: a coined compound, so it needs the tagline
   on first contact. CLI `seatboard`, env `SEATBOARD_`, config
   `~/.config/seatboard`.
2. **Boardseat.** The richest meaning: "a seat on the board" is the person who
   governs direction, which is exactly the seat's job, and it reads as an
   ordinary English phrase. npm, `.dev` and the GitHub account are free.
   Weakness: an advisory-board networking company and a board-recruitment
   service use the same name, and search results will be full of corporate
   governance. Trademark check matters most here.
3. **Vataha.** The strongest story and a distinct voice: a crew and its
   leader, a Ukrainian word nobody in the space uses. npm and `.dev` free.
   Weaknesses: English speakers get no meaning from it; the GitHub account is
   taken (empty); some Ukrainian and Russian listeners may hear «вата». Choose
   it if identity matters more than instant clarity.
4. **Agentseat.** The most self-explanatory and searchable ("agent" is what
   people type). npm and `.dev` free, `.com` for sale. Weaknesses: a small
   Wayland project called AgentSeat exists in the AI-agent space, and the
   GitHub org name is registered (empty). Among 235 orchestrators, a name
   starting with "agent" blends in.
5. **Yardmaster.** The best metaphor for lanes and stages, and a real English
   word that reads naturally in Ukrainian. npm free. Weaknesses: `.dev`,
   `.com` and `getyardmaster.com` are all registered, the GitHub account is
   taken, and two industrial software products (lumber, rail yards) use the
   name. Pick it only with a different domain (`yardmaster.sh`,
   `useyardmaster.com`: not checked).

Runner-up if the operator wants something plainer than 1–5: **Laneboard**
(npm, `.dev` and GitHub free, no namesake). It describes the pipelines well
and says nothing about the seat.

---

## 5. Rename impact inventory and migration plan

### Where the old names live (counted at this branch's head)

| Surface | Current value | Scale | Who depends on it |
| --- | --- | --- | --- |
| GitHub repository | `live-log-viewer-next` | 1 repo | clones, CI, PR links, the npm `repository` field |
| **Project identity** | `repo-<sha256 of host/owner/repo>` from `origin` (`src/lib/projects/identity.ts`) | every task, seat, pipeline, binding of this project | the board, the seat store, attention, accounts |
| npm package | `agent-log-viewer` (published, 1.2.2) | 1 package | `bunx agent-log-viewer`, global installs |
| npm bins | `agent-log-viewer`, `agent-log-viewer-mcp` | 2 bins | every agent config that registered the MCP server by command; `scripts/install-mcp.sh`; the publish workflow's smoke check (`Usage: agent-log-viewer`) |
| Config dir | `~/.config/agent-log-viewer/` (legacy fallback `live-log-viewer`) | computed in `src/lib/configDir.ts`, `src/lib/stateOwnership.ts` and separately in `bin/mcp-server.mjs`, `bin/server-runtime.mjs`, `bin/tailscale.mjs`, `bin/provision-telegram-connector.mjs`, `scripts/bootstrap-runtime-host.ts`, `scripts/runtime-host-viewer-adapter.ts`, `src/runtime-host/stagingContainer.ts`, `docker-compose.yml` | **absolute paths stored in state**: transcript paths under `shared/`, account homes under `accounts/`, MCP server definitions pinned with the state dir, the runtime-host socket and journal paths |
| Cache dir | `~/.cache/agent-log-viewer/whisper-venv` | 1 | local dictation |
| Env prefix | `LLV_` | 254 distinct variables in 611 files; 7 documented in the README, 20 in `docker-compose.yml`; `VIEWER_PROC_BACKEND` has its own prefix | operators' `service.env`, compose overrides, CI, tests |
| Docker | compose project `agent-log-viewer`; images `agent-log-viewer:node22`, `:deploy-*`, `:staging-*`, `:hostboot-*`; containers `llv-runtime-host-<rev>-<gen>`, `llv-deploy-*`; `/opt/llv-whisper-venv` | runtime host, deploy adapter, bootstrap | the runtime host that performs release succession |
| Legacy service names | `agent-log-viewer.service`, `agent-log-viewer-legacy-tmux.service` | 2 units (retired; `docs/docker.md`, "Moving off the systemd install") | old installs |
| MCP server key | `viewer` (tools appear to agents as `mcp__viewer__*`); `presentation.ts` also accepts `agent-log-viewer*` | every agent's MCP config, permission allowlists, skills and memories | all agents |
| Product noun in UI and prompts | "the Viewer": about 1,000 uses in non-test `src/`, 200 in MCP tool descriptions, 94 in orchestrator/role/pipeline prompts; 44 in `en.ts`, 41 in `uk.ts` | agent-facing and operator-facing text | agents learn the product from these |
| Product name strings | `onboarding.title`, `onboarding.tour.heading` (en, uk); `src/app/layout.tsx` title and description; CLI usage and messages in `bin/cli.mjs` (en, uk) | ~12 strings | first-run and tab title |
| Browser storage | cookie `llv_auth`; dozens of `llv:*` and `llvAgentRuntime:*` localStorage keys | per browser | saved sessions, layout, per-project dock state |
| Stable external ids | WakaTime entities `agent-log-viewer/<engine>/…`; push VAPID subject | 2 | deduplication with data already sent |
| Docs | README, AGENTS.md, 36 Markdown files mention an old name; CHANGELOG | — | readers |
| Repo skills | `.claude/skills/live-log-viewer-orchestration`, `llv-conveyor` | 2 | agents load skills by name |
| Worktree folders | `<checkout-folder>-pipeline-<id>` (`src/lib/pipelines/store.ts`) | derived from the local folder, independent of the repo name | — |

### Migration plan

The rule for every step: an install that worked before the rename keeps
working after it without the operator doing anything, and nothing already
recorded (tasks, seats, conversations) changes key.

**Step A: the GitHub repository and project identity (do this first, carefully).**
Project identity is a hash of the `origin` remote. Renaming the repository on
GitHub is safe by itself, because GitHub redirects the old URL and existing
checkouts keep their `origin`. The moment any checkout updates `origin`, or a
fresh clone is made (a second machine, the dev server), the same repository
hashes to a **new project key**, and its seat, tasks and pipelines fall under
the old key. `src/lib/projects/succession.ts` deliberately refuses to alias a
changed remote, because a remote names every clone. The rename therefore
needs one narrow addition before anyone touches `origin`: alias an old
canonical remote to a new one only when the forge proves they are the same
repository (the GitHub repository id behind both names matches). That keeps
the existing refusal for re-pointed remotes. Add a "renamed repository keeps
its board" case to the succession tests.

**Step B: npm package and bins.** Publish the new package with its new bins
**and** the two old bin names as extra entries, so `agent-log-viewer-mcp` in
existing agent configs and `bunx agent-log-viewer` keep resolving. Publish a
final `agent-log-viewer` release that depends on the new package and
re-exports its bins, then `npm deprecate` it with a one-line pointer. Update
`scripts/install-mcp.sh` and the publish workflow's smoke check. Keep the old
bins for at least two minor releases.

**Step C: config and cache directory.** Do **not** move existing
directories. Absolute paths into `~/.config/agent-log-viewer` are stored in
state (transcript paths, account homes, pinned MCP definitions, the
runtime-host socket), so a move would break them, and a compatibility symlink
would still split identities wherever a path is canonicalised with
`realpath`. Instead:

1. Collapse the separate computations listed above into one
   resolver (a tiny shared module the `.mjs` entry points can import).
2. Resolve with the precedence `configDir.ts` already uses for the previous
   rename: new dir if it exists, else `agent-log-viewer` if it exists, else
   `live-log-viewer` if it exists, else create the new dir. New installs get
   the new name; existing installs stay where they are, indefinitely.
3. `docker-compose.yml` defaults follow the same rule through one variable
   (the env file, socket and journal paths all derive from it).

**Step D: env prefix.** Accept `<NEW>_X` for every `LLV_X` by copying it into
`LLV_X` when `LLV_X` is unset, and warn once when both are set and differ.
Internal code keeps reading `LLV_` for now. The copy has to run **before** each
entry point's module graph loads, the same trap AGENTS.md documents for
`LLV_STATE_OWNER`: `bin/cli.mjs`, `bin/mcp-server.mjs`,
`src/runtime-host/main.ts`, `src/instrumentation.ts`, `src/lib/mcp/entry.ts`.
Document only the new names in the README; mention the old prefix in one
line. Children inherit both, so spawned agents see no change.

**Step E: Docker.** Image tags, container names and the compose project name
are read by the runtime host that performs the next deploy, and that host is
running the *previous* release. Change them only in a release after the one
that teaches the runtime host to recognise both names, and rehearse it with
`bun scripts/verify-runtime-host.ts` like any change to what the host runs.
Keep `name: agent-log-viewer` in compose until then, because changing it
renames containers and networks under a running install.

**Step F: text the operator and agents read.** In one lane: UI product name
strings (en and uk), the page title, CLI messages, README and docs, the
onboarding tour, the product noun in orchestrator/role prompts and MCP tool
descriptions. Agents learn the product from those descriptions, so the new
name should land there in the same release. CHANGELOG history stays as
written.

**Step G: skills.** Rename the repo skills and leave each old skill name as a
two-line stub pointing to the new one for the alias period, since agents'
memories and prompts load skills by name.

**Order:** A (identity alias) → B, C, D, F in one release → E in the next
release → remove the npm shim and old bin names after two minor releases.
The old env prefix and old config dir stay accepted with no end date; they
cost one lookup each.

### Deferred: not currently justified

- **Renaming the MCP server key `viewer`.** Every agent's MCP registration,
  permission allowlist (`mcp__viewer__*`), skill and memory uses it, and
  registering two names would duplicate the whole tool list in every agent's
  context. "Viewer" still describes what the server is from an agent's side
  (its view onto the board). Revisit only if the operator wants the old word
  gone everywhere; then register the new key, keep `viewer` resolvable for
  one alias period, and migrate allowlists.
- **Moving existing config directories.** Covered in Step C; a migrate
  command can come later if an install ever needs it.
- **Renaming the 254 internal `LLV_` variables in code.** The boundary alias
  in Step D gives users the new prefix; a mechanical rename of internals buys
  nothing for users and touches 611 files.
- **Browser storage keys, the `llv_auth` cookie, `llv-*` container and temp
  prefixes, WakaTime entities.** Invisible identifiers; renaming them logs
  everyone out, resets saved layouts or duplicates external data.
- **Renaming the local checkout folder.** Worktree folder names come from it,
  and deleted worktrees under the old folder name group through the persisted
  worktree map; renaming it is optional and outside this rebrand.
- **The icon.** Follows the chosen name, as the task says.

## Sources

Web checks, 2026-09-22:
[Conductor in a tool directory](https://tooldirectory.ai/tools/conductor),
[conductor.build intro](https://codepick.dev/en/guides/conductor-build-intro/),
[awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators),
[BoardSeat on LinkedIn](https://ca.linkedin.com/company/boardseat),
[Boardseats](https://app.boardseats.io/),
[AgentSeat on DeepWiki](https://deepwiki.com/vimalinx/AgentSeat),
[YARDMASTER on SourceForge](https://sourceforge.net/software/product/YARDMASTER/),
[YardMaster Solution](https://yardmastersolution.com/),
[Hromada (disambiguation)](https://en.wikipedia.org/wiki/Hromada_(disambiguation)),
[Nimbalyst multi-agent tools overview](https://nimbalyst.com/blog/best-multi-agent-coding-tools-2026/).
