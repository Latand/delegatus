# Changelog

All notable changes to Delegatus (`delegatus-cli`, published as
`agent-log-viewer` before 1.3.0) are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/), including its compatibility
guarantees for the 1.x series.

## [Unreleased]

## [1.9.1] — 2026-10-03

### Added
- **Update replaces the whole installation.** Checkout and packaged updates
  replace the resident launcher, Viewer and runtime host together, verify their
  serving identities, and restore the previous release on failure. Recovery
  Viewers re-adopt their launcher; manual and older installs receive the exact
  prerequisite action. Checkout `deploy_exact_sha` uses the same durable apply
  and settlement path ([#2495]).
- **Busy installations drain admitted work before an automatic update.** New
  autonomous work waits while the original cohort finishes. The hold survives
  recovery, both restart roles and rollback. After six hours the dialog names
  the blockers and offers **Deploy now** or **Keep waiting** ([#2430]).

### Fixed
- **Legacy launcher upgrades restore the prior serving release.** If an older
  launcher already published a candidate and switched only the web process,
  the one-time bootstrap captures rollback from the verified serving host.
  A failed host or web start restores both processes on that release; an entry
  that cannot load is refused before restart ([#2495]).
- **The host deploy command authenticates on team installations.**
  `scripts/rebuild.sh` uses the existing controller credential for admission
  and status polling. The client connects only to a validated loopback address,
  refuses redirects, and keeps credentials out of arguments and output. Receipt
  replay and deployment exit codes are preserved ([#2495]).
- **Bun-only MCP startup checks use the shipped launcher modules.** The macOS
  newcomer fixture and the hermetic MCP fixtures now copy the published `bin`
  directory, including platform identity and launcher helpers, so new imports
  are covered automatically ([#2495]).

### Maintainer notes
- The installed `braces` dependency carries the runtime mitigation from upstream
  tree `28d440b5dd449dbf1fe6f3506cf94ecca4d02660`, with nesting, AST and
  parent-cycle regressions in the release gates. The locally fixed advisory
  metadata expires on 2026-10-10; [#2496] tracks removal after an upstream release.
- Release-pointer reads and update admission retain main's asynchronous Git
  checks together with durable drain custody. This version prepares the npm
  release; tagging and publication are separate release steps.

## [1.9.0] — 2026-10-01

### Added
- **Board maintenance on the seat tick.** The seat tick panel (the popover
  on a desktop, the sheet on a phone) has a **Board maintenance** group with
  a switch and an interval in hours, from 1 to 168. It is off by default and
  runs every 3 hours once switched on. Each run starts one maintainer agent
  for the project, on its own task card, that reads the previous run's
  summary and log, checks transcripts, branches and stage attempts, and then
  updates statuses and blocked reasons on the board. It never edits files in
  a repository, never deletes or hides your task details, and cannot mark
  done a task that has an open pipeline or a live agent. A run that
  succeeds summarizes its card, marks it done and hides it, and archives its
  conversation. A failed run leaves a blocked card. The group shows the last
  run, its result, the next run and a link to the run's card, and a run
  waits while a deployment is running. The same settings are available to
  agents through `seat_tick_settings`, which now also returns the last and
  live run, the next-run estimate and the run history ([#2384]).
- **Each tool call shows the context tokens it added.** Next to a call's
  duration the feed now prints how many context tokens the call's result
  added, such as `352ms · 12.4k`, for Claude and Codex, on tool lines, rows
  inside a group, the phone's run rows, the group header and the MCP call
  card. The number is the growth in the provider's prompt size, or an
  estimate marked `~` when no measurement is possible, and a call that is
  still running shows nothing. Four bands set the colour: under 1 000 is
  quiet, 1 000 to 9 999 amber, 10 000 to 19 999 orange and 20 000 and above
  semibold red. The hover text says whether the value was measured, shared
  between parallel calls or estimated ([#2383]).
- **A linked task shows its pipeline and where it is managed.** A task that
  runs on a linked install now shows its pipeline on the card here: the
  stages in the owner's order, each stage's state, the loop counters and the
  current stage. The card has a tinted border and a "Managed on" chip with
  the machine's name where **+ Agent** was. Only identifiers and states
  cross the link, never prompts, findings, paths or conversation ids, and an
  install on an earlier release keeps syncing and shows the card without a
  pipeline ([#2377]).
- **A clear message when no agent CLI is installed.** The start output now
  says how to install Claude Code and Codex when neither is found, and the
  setup guide's account connection finds the Codex CLI inside the macOS
  Codex app bundle, as agent launches do. The landing prompts check and
  install the chosen CLI and register the MCP server with absolute paths,
  and the Delegatus package entrypoints run on Bun alone, without `node` on
  `PATH`. `docs/macos-newcomer.md` holds the manual checklist ([#2376]).
- **Anonymous install ping, on by default.** Once per UTC day the production
  Viewer sends delegatus.org a random id made for this purpose, the
  version, the OS, the architecture and the install kind (`packaged`,
  `checkout` or `docker`). It sends no path, host or user name, project,
  account, engine or usage figure, and the landing Worker stores the five
  values with the country Cloudflare reports, and no IP address. The first
  start shows a notice in the product and in the start output. Turn it off
  in **Settings → Anonymous install ping**, with `DELEGATUS_TELEMETRY=0`
  or with `DO_NOT_TRACK=1`; the two variables win over the setting. Tests,
  builds, development servers and CI send nothing ([#2382]).

### Fixed
- **Scrolling a fully expanded conversation on the board is smooth.** After
  **show earlier** had loaded the whole history of a long conversation, each
  scroll frame measured every answer in the feed to decide which one the
  speak button reads, and the board frame resized itself in container units
  on every frame. The measure now looks only at answers on screen, the board
  frame no longer re-resolves its size on scroll, and the reading anchor
  uses a bisection. In a trace of one 451-row conversation, 43% of the
  frames moved the scroll before and 99% do now. History and what **show
  earlier** loads are unchanged ([#2388]).
- **Reports from a project without a name no longer fail.** A report filed
  with `bridge_report` from a project known only by its key failed while the
  report header was built on the server. The header now reads "Unnamed
  project" or "Проєкт без назви". Named projects are unchanged ([#2387]).
- **Landing demos on a phone stay inside a phone frame.** An expanded phone
  demo used to switch to an unscaled, edge-to-edge viewport. It now keeps its
  390 px viewport and scales the whole frame to the available width and
  height, with a rounded border, in portrait and landscape, and it refits
  when the visible area shrinks ([#2385]).

### Maintainer notes
- The privacy inspection jobs cache their media tools (apt indexes and
  `.deb` archives) per runner image, install them offline and bound retries,
  so a slow package mirror no longer fails the privacy checks ([#2380]).
- A new workflow, `macos-newcomer`, installs Bun and the packed package on a
  clean macOS runner, starts the real package and checks the launcher message
  and the setup API with no CLI, with each engine's stub and with a Codex
  app-bundle stub. It runs manually, on relevant pull requests and on release
  tags ([#2376]).

## [1.8.0] — 2026-09-30

### Added
- **Read aloud starts at once with Soniox.** The speaker button in a
  conversation header reads the answer in view. The first sentence is
  requested alone and plays as soon as its audio arrives, and the later
  sentences are fetched a few at a time behind it. In our browser
  measurement of one 329-character answer the sound began after a median
  of 0.5 seconds, where the previous path took a median of 18 seconds. The
  header button and each answer's own button share one **Stop**, which
  works while the audio is still loading and after the feed has scrolled or
  grown. OpenAI and ElevenLabs speech play as before ([#2366]).
- **A Context toggle in the Codex composer.** A Codex conversation's
  composer can send its draft into the running turn as context. In Auto the
  toggle follows the turn: it switches on after the turn has been running
  for 0.4 seconds, off 2.5 seconds after it ends, and waits for 1.5 seconds
  without typing. A press overrides Auto for that card. The sent words show
  at once as a pending row that settles against the transcript. A refused
  context message offers **Edit** and is never sent again by itself, an
  unanswered one offers **Check status**, and while the runtime is offline
  the send is refused with its reason and the draft stays in the box. A
  host that has not advertised context injection keeps the toggle and says
  why when you tap it.
- **Codex service tier per launch, per stage and per role.** `spawn_agent`,
  the stages of `create_pipeline`, `pipeline_action` `override-stage` and
  the role table accept a `serviceTier`. The tier is checked against the
  chosen account's model catalog before the launch. An explicit tier that no
  account offers is refused with the offered tiers named, and a role's
  default tier falls back to the standard one with the fallback shown. The
  tier stays with the agent through resume, restart and reconfiguration.
  The existing `fast` option still means the `priority` tier, and the
  runtime pill names a tier other than standard. Your Codex
  `config.toml` is left alone.
- **Agents can read and change the role mapping.** The new `role_presets`
  tool returns each role's engine, model and effort, the shipped values,
  the valid model and effort choices, and the registry revision. The
  orchestrator seat and your own session can write with the same patch the
  Settings agent mapping uses. A model or effort outside the launch
  catalogue is refused with every violation listed and nothing written, a
  stale `expectedRevision` is refused with the current registry, and every
  write is recorded in `role-presets-audit.jsonl` beside `role-presets.json`
  ([#2348]).
- **Agents can switch automatic updates.** The new `auto_updates` tool
  returns the state the Update dialog shows. The orchestrator seat of the
  Delegatus project, or your own session, can turn the switch on or off. It
  is the dialog's switch, so the dialog, its "turned off because" line and
  the update controller all see the change. Other callers are refused
  before anything is asked of the Viewer, and enabling is refused where
  automatic updates are unavailable. The dialog's history now lists each
  switch with who made it and when ([#2360]).
- **The landing page counts four anonymous actions and says so.** The
  footer, in English and Ukrainian, now discloses the site analytics. The
  page records that a visitor copied the prompt, copied the
  `bunx delegatus-cli` command, started the demo or opened it full screen,
  together with the page language, the agent for a prompt copy and the country Cloudflare
  reports. It sets no cookie and stores no visitor id or IP address, and the
  copy and fullscreen controls work when analytics is unavailable ([#2365]).
- **For maintainers: usage metrics from one command.**
  `scripts/usage-metrics.ts` reads npm daily downloads and version splits, GitHub views, unique visitors,
  referrers and stars, and sampled Cloudflare visits to the landing page.
  `--line` prints the Ukrainian daily message. Every run appends a snapshot
  without credentials to a local history file, `--history` moves it, and a
  source that fails is named while the rest still print ([#2368]).

### Changed
- **Linked boards keep fresh state and the local band limit.** A link's
  freshness, cursors and sync queue now live in one place across the web
  app's bundles, so a linked board no longer looks frozen and two syncs of
  one link no longer run at once. A task that arrives from a linked install carries the sender's shown or hidden
  membership. A done task with no membership arrives hidden, and arrivals
  past the 300-band limit stay hidden, so linking a project with a long
  history no longer floods the board. Done tasks that had already arrived
  are hidden once, and a band you restore or hide yourself is kept ([#2359],
  [#2370]).
- **Shared tasks keep their titles.** A project you agreed to share crosses
  with its complete task text where it used to arrive as "Untitled task".
  Tasks that had already arrived with that placeholder are filled in on the
  next sync, and a newer edit of yours wins. Each of the two installs needs
  this release before they exchange tasks again: an install without it
  rejects the new rows and applies none of that page ([#2359]).
- **A narrow task card draws its pipeline stages as one vertical chain.**
  Under 380 px the stages stand one under another on a rail with no sideways
  arrow, their names wrap in place, and a fail branch such as **Review fix**
  is indented under its reviewer on a dashed elbow. Wider lanes keep their
  row ([#2363]).
- **Completed task bands leave the board after three days.** A task marked
  done drops off the board three days later and stops counting toward the
  project's band limit. It stays in the task list, in search and in
  `get_task`. The seat's own task stays. A new admission or a later decision
  request brings a hidden task back, and a new admission starts its three
  days again.
- **Review budgets default to three rounds.** Pipeline fail edges, flows,
  workflows, converted review loops, the embedded review flow and the board
  all start at three review rounds. A higher number applies only when it is
  set explicitly, and values already stored stay as they are. The
  orchestrator mandate now picks the rounds by risk: one for low, two for
  normal, three for high, more only on request.
- **Builder fallbacks land on GPT-6.1-Sol.** When a role moves from Claude
  to Codex, Sonnet (`sonnet` and `claude-sonnet-5-5`) now lands on GPT-6.1
  Sol instead of GPT-6 Sol, and the `builder:frontend-fixes` and
  `builder:docs-fixes` rows use GPT-6.1 Sol at high effort. Your saved role
  rows do not change ([#2347]).
- **Messages from agents steer an active Codex turn.** A message from an
  agent or a seat to a Codex agent in the middle of a turn now steers that
  turn, or queues, and falls back to a durable delivery under the same
  operation if the steer cannot be made.
- **The orchestrator seat panel is quieter.** Launch chips, MCP task rows
  and shell rows are one line each, with the full text in a tooltip.
  Launch-recovery bookkeeping no longer shows as raw JSON, the runtime pill
  follows the seat's own launch profile, the mandate shows as a collapsed
  **Mandate** card, and Claude ToolSearch rows are dropped from the feed.
  A structured runtime pill drops a stale draft so that a send carries the
  model the pill names.

### Fixed
- **Next.js 16.3.6 security update.** Delegatus moves from Next.js 16.3.3 to
  16.3.6, which closes the remote code execution advisory in `next/og`
  `ImageResponse` (GHSA-vcvr-r3jv-pc5j) that affected 16.2.0 up to 16.3.5.
- **A message to an agent arrives once or fails with its reason.** A
  message to a finished or idle agent is delivered once within a bounded
  wait or ends in a failure that names its cause. A finished flow reviewer
  no longer holds its launch marker, so the next message resumes it. A
  resume that cannot publish its host is settled failed within 60 seconds.
  A structured launch that meets a runtime-host handover retries for up to
  30 seconds where it gave up after three attempts. A held message whose
  delivery cannot start is retried and, after 10 minutes, fails with
  "not delivered" and the cause, which makes a resend safe. A `send_message`
  that the Viewer refused before reserving anything reports "not executed"
  with the reason, where it read "outcome unknown". A failure inside the
  registry migration rolls the whole step back ([#2358]).
- **Admitted messages stay pending across a restart, and resend works.** A
  message the runtime had already admitted is read back after a restart
  until its durable receipt arrives, and a delivered receipt overrides a
  stale local "failed". The resend control appears only when its handler is
  there and resends the failed retry the receipt names. A manual status check
  after a failed poll settles the row as delivered without sending it again
  ([#2338]).
- **Transient network and Git failures are retried.** A DNS or connect
  error, a Git ref, index or packed-refs lock held by another Git process
  and a checkout killed by host load are retried with a bounded backoff
  before a lane parks or a deploy fails. This covers a pipeline's base fetch,
  a deploy's mirror fetch and the image build's `docker build --pull` and
  `bun install`. When the retries run out, the park or the error names the
  cause, the host where there is one, and what to do ([#2355]).
- **A healthy promoted release is no longer rolled back for being busy.**
  The wait after promotion restarts each time the new Viewer reports a
  startup phase or adoption count it had not reported, with a 20-minute
  ceiling, and its error says which bound fired. A rollback that fails at
  first keeps the reason for the rollback beside its own error. A Compose
  key the running deployer cannot apply is refused before the image build
  with instructions to deploy a revision that teaches the deployer the key
  first, which `docs/RELEASING.md` now describes ([#2350]).
- **The resource worker no longer creates account stores.** The background
  resource collector used to write account files and `state.sqlite` into
  the state directory when it started. It no longer loads the scanner up
  front, and a state directory holding only the registry stays that way
  ([#2349]).
- **Codex queues survive a cold restart.** When Delegatus adopts an idle
  Codex conversation whose native queue still holds a submitted message,
  it starts that message once after resuming, without adding the input
  again, and keeps the conversation's attention and recorded pauses. A
  queue stranded by an earlier release is recovered from the queue panel,
  which the docs describe.

## [1.7.1] — 2026-09-29

### Added
- **Automatic updates on a managed install.** The Docker install's **Update**
  dialog now has the **Automatic updates** switch too, off by default. It
  needs a readable release target and a GitHub remote. Once a merged pull
  request's checks have all finished green, Delegatus waits for the same
  quiet moment an install run from a clone waits for, then asks the runtime
  host for the same deployment the **Update** button makes, with its health
  check and its rollback. A restart of the web app in the middle does not
  start a second deployment, and the dialog shows the deployment's progress.
  A failed or rolled-back deployment turns the switch off and shows its
  target and reason ([#2326]).
- **Agents can send photos and albums to Telegram.** The new
  `telegram_bot_send_media` tool posts one image, or two to ten as one
  album, to a chat you allowed, with a caption for each image. Files must be
  JPEG or PNG, each up to 10 MB, and are read from the document folders
  described below. Like text messages, the media follows the
  chat allowlist, is signed with the calling conversation, and a repeated
  call with the same request id posts nothing twice ([#2327], [#2340]).
- **Agents can send report files to Telegram.** The new
  `telegram_bot_send_document` tool posts one Markdown, text, log, JSON,
  CSV, HTML, PDF, PNG or JPEG file, up to 20 MB, to a chat you allowed,
  with an optional caption. Files are sent only from the document folders
  you set under **Document folders** in the Telegram panel, `handoff/` in
  your home by default, and never from a dot-folder or the Delegatus state
  folder. A text file that holds a password, a token or a provider key is
  refused before anything is sent. The shown filename may be changed but
  must keep the file's type, and a repeated call with the same request id
  posts nothing twice ([#2340]).
- **GPT-6.1-Sol is a selectable Codex model.** It appears in the model
  menus right after GPT-6-Astra, takes images, and offers the same effort
  levels as GPT-6-Sol, from low to ultra. No default or role preset
  changes ([#2342]).
- **The owner sees every member's activity.** On the **Activity** page the
  owner, or the operator of a single-person install, can filter by member
  or choose **All members**, which adds a per-member breakdown of report
  hours and projects. Two people working in the same hour count as two
  hours. Another member's figures never say "you" or "your", and a member
  whose hours live only on a linked machine reads "Not covered" instead of
  zero. A member who opens a link that names someone else lands on their own
  figures ([#2337]).
- **A launched agent tells you when it finishes a turn.** When an agent
  started through `spawn_agent` ends a turn, the conversation that launched
  it gets one short notice, once per outcome, and it still arrives if the
  runtime host restarts in between. Delegatus records who launched an agent
  itself and ignores a launcher an agent claims. A launcher that has been
  archived or replaced is skipped with the reason, and a notice for a
  retired orchestrator seat goes to its successor. Agents run on the
  tmux fallback send no notice, and `spawn_agent` accepts
  `notifyLauncher: false` to turn it off for one agent ([#2339]).

### Changed
- **The Linked installs dialog walks you through the pairing.** It opens on
  two roles: **This machine accepts a connection** and **This machine
  connects to another**, each with three numbered steps that say which
  machine must reach the other. An address the install cannot check from
  itself is now an amber warning, "Not checked from here", with the address
  to check from the other machine. Problems that block linking stay red.
  The pairing code appears with the saved address, each with a Copy button.
  A failed connection reads as a sentence under the connect form, and the
  dialog lists the connected machines ([#2336]).
- **Claude models follow the Sonnet 5.5 / Opus 5.5 table.** Builders, their
  variants, the cleaner and the verifier run on Claude Sonnet 5.5; the
  orchestrator, architect, reviewer, production auditor and deployer stay
  on Opus. Sonnet may also review or gate a trivial stage, and an install
  that already saved its role rows keeps them ([#2331]).
- **A checkout install can turn on automatic updates.** The launcher of an
  install run from a clone now runs the launcher from the installed release,
  so later launcher changes arrive with each release. If the switch says the
  launcher needs a one-time setup, the dialog names the two commands to run
  in the install's folder before one restart ([#2334]).

### Fixed
- **A stale automatic update no longer blocks the next one.** On a managed
  install, a request the runtime host never accepted stayed saved after main
  moved on. It is now cleared once the host confirms it was never admitted,
  and the newer commit goes through the green and quiet-moment checks
  again. A late failure still turns the switch off with its reason
  ([#2333]).
- **Old Viewer workers stop.** The background worker that keeps account
  migration current used to outlive a Viewer that was killed or replaced by
  a new release, and one was found holding about 480 MiB after two days. It
  now exits with its Viewer, or when the installed release moves on. It also
  no longer keeps a second copy of the registry in memory, which took an
  isolated test from about 1.3 GiB to 0.8 GiB. An idle agent host is no
  longer kept alive for months by an old unfinished spawn record ([#2317]).
- **Review fixes reach the pull request before the next review.** When a
  builder fixed what a review found, the fix could stay only on the local
  branch. The pull request then fell behind the commit that was reviewed,
  and merging stopped because the pull request head had changed. Delegatus
  now publishes each accepted fix before the next stage starts, keeps the
  stage waiting if the push fails, and names the reviewed commit when a
  pull request is behind it ([#2335]).
- **The runtime host lets go of finished connections.** Under the Bun
  version the Docker image runs, the deployment proxy in front of the web
  app kept every connection it had already answered, so they piled up and a
  release handover could wait on them forever. Each connection is now
  closed once its answer is sent, within a second at most ([#2343]).

## [1.7.0] — 2026-09-29

### Added
- **Automatic updates for an install run from a clone.** The **Update**
  dialog has an **Automatic updates** switch, off by default. When it is on
  and a merged pull request's checks have all finished green, Delegatus
  builds that commit and waits for a quiet moment: no agent turn or pipeline
  stage running, nobody using Delegatus for ten minutes, no other update
  in progress and enough free memory. It then moves the web app onto the
  new release first and the runtime host second. While it waits, the
  dialog says what it is waiting for, and after 24 hours it says that too.
  Each process shows the revision
  it runs, and the update history marks which builds and restarts ran by
  themselves. If an automatic restart fails, Delegatus goes back to the
  release before it and turns the switch off with the reason ([#2313]).
- **Agents on a linked install show on your board.** For a project both
  machines share, the other machine's agents appear as a collapsed,
  read-only row: "On *machine*: 3 agents · 1 working", on the card of the
  task they work on, or in the Inbox when they have no task. This works on
  the desktop and on the phone. Only a short title and a state cross over,
  never a transcript, a prompt, a path or an account. If the link stops
  answering, the row says how old it is after 15 minutes, and revoking the
  link removes it. Agents read the same rows through `get_task` and
  `board_snapshot` ([#2305]).
- **An external relay can ask your install questions.** **External relay**
  in the rail menu (the ⋯ sheet on a phone), and an optional **Relay
  service** step in the setup guide, pair this install with a relay service
  that collects questions from its own chats. Your install asks the service
  for work, so nothing outside can reach it. Each question is answered by a
  one-shot agent on your signed-in Claude or Codex account, with no shell,
  no tools and none of your own instruction files. For each paired relay the
  page shows its connection state, its last answer, and the engine, model,
  effort and number of parallel answers it uses ([#2302]).
- **The orchestrator starts with a board report.** Whenever an orchestrator
  takes its seat (a new one, an adopted one, or after a rotation), it gets a
  report on its project's board: decisions waiting on you, tasks ready to
  finish, stuck agents with their last words, what is running, tasks nothing
  works on, cards that look safe to close with the reason, pull requests no
  pipeline carries and, for a GitHub project, open issues ranked by the
  priority recorded on them. The orchestrator checks each item before it
  acts, closes cards one at a time and asks you before anything else. A
  project with nothing to report gets no report ([#2308]).
- **Claude Sonnet 5.5** is in the model lists. The builder for UI work now
  runs on Sonnet 5.5 at high effort, and the orchestrator plans a UI
  pipeline with an Opus stage that writes the brief and an Opus review.
  Other roles keep their models ([#2312]).
- **Each pipeline stage shows its model.** In place of the green status dot,
  a stage draws the model it runs on: a spark for Claude Opus, Sonnet and
  Haiku, a fox for Fable, and a sun, a star, the Earth and the Moon for the
  Codex models Sol, Astra, Terra and Luna. A running stage's figure moves,
  a waiting one is dimmed, and a finished stage wears a small tick, cross or
  bang for passed, failed or needs you. Other models keep their dot. The
  figures stand still when the system asks for reduced motion ([#2311]).

### Changed
- **The next pipeline stage gets the whole brief.** A stage used to pass on
  only the one-line summary of its report. The next stage now receives
  everything the agent wrote before it reported, up to 60 KiB and marked
  when cut. The summary still heads the board's stage row
  ([#2315], [#2320]).
- **Agents get only the API keys Delegatus uses.** Of the variables ending
  in `_API_KEY` in the environment that starts Delegatus, only
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
  `ELEVENLABS_API_KEY` and `SONIOX_API_KEY` reach the agents and commands it
  starts. Give an agent any other key through its own configuration
  ([#2318]).

### Removed
- The WakaTime export (`LLV_WAKATIME_ENABLED`) is gone. The setting has no
  effect any more, and the Activity page is unchanged ([#2318]).

### Fixed
- **Pairing works behind Caddy.** An install whose public address sits
  behind Caddy, the Docker install among them, failed every address check
  and **Allow a connection** made no code. The check now passes there. An
  HTTPS address written as an IP no longer fails the check, and an address
  the check cannot confirm still gets a pairing code, unless a local entry
  point trusts callers without the access key ([#2325]).
- **Telegram report topics.** Pasting a group or topic link for a chat the
  bot had not seen yet, or a forum whose topics had changed, now saves the
  destination, and the Reports picker shows the new chat as allowed right
  away. A link Telegram refuses shows Telegram's reason ([#2309], [#2316]).
- An update step whose command disappears or runs past its deadline now
  stops in the running web app, so you can retry it without restarting the
  web app ([#2313]).

## [1.6.0] — 2026-09-28

### Added
- **Linked installs share a board.** Two Delegatus installs, say your laptop
  and a server, can now be paired. **Linked installs** in the rail menu (the
  board's ⋯ menu on a phone) first sets this install's public address. It
  needs HTTPS and the access key, and a self-check says whether the address
  really reaches this machine and whether the proxy in front of it is safe.
  One install then makes a single-use pairing code and the other enters it.
  Nothing is shared until you choose: pick projects one by one (from the
  dialog or the board's ⋯ menu) or share every project, including new ones. A
  project needs a git remote to be shared. Each side shows whether a project
  is linked, shared only here, or only on the other machine, and you can
  revoke or remove the link. For a project both machines share, tasks sync
  both ways: a task created, edited or deleted on one machine appears on the
  other after the next sync, which runs within seconds while a linked board
  is open. Each task belongs to the machine that runs it, and the other
  machine refuses to start agents or pipelines for it. A task's text crosses
  only once someone has named it. Until then it shows as "Untitled task"
  ([#2280], [#2287], [#2298]).
- **Sign-in and team.** One Delegatus can be shared by a team, each person
  signed in as themselves. An owner claims the install from ⋯ → **Team**,
  then invites people with a one-time link that lasts seven days. Other
  devices sign in with a passkey, through the install's Telegram bot, or by
  approval from a device that is already signed in, and the phone QR signs
  the phone in as you. The chat names the sender of each human message. The
  Team page lists the members, what each of them did (messages, answers,
  agents started, tasks changed) and every signed-in device, with sign-out
  and revoke. `delegatus team recover` on the host prints a one-time owner
  link. A failed passkey sign-in or registration says what went wrong and
  what to try next. A Delegatus used by one person is unchanged: no sign-in
  page and no new step ([#2243], [#2264]).
- **Activity per team member.** On a team install, Activity counts each
  member's own hours, and input with no known author is shown as a separate
  count. A linked remote can be told which member's rows to send. Each
  project now counts its own hours, so one clock hour can count for several
  projects you worked on in parallel, and the day's total counts it once.
  Scripts that send through the composer routes no longer count as your
  time. On the phone, ⋯ → Activity opens the page, which now fits the
  screen ([#2224], [#2238], [#2270]).
- **Orchestrator reports go to the Telegram chat you pick, per project.**
  Reports come regularly, in one shape, in your interface language. Every
  finished deploy or pipeline and every unanswered question is reported,
  with a digest when the board moved and nothing was reported. Each
  orchestrator has a **Reports** section in its own row (the seat sheet on
  a phone) with an "Also to Telegram" switch and the group to post to. Only
  a project you turned on posts to Telegram. A group the bot cannot see
  updates for can be added by its id, `@username` or `t.me/` link, and a
  topic link posts into that forum topic. Orchestrators can also use your
  Telegram connector when it is connected ([#2236], [#2237], [#2242],
  [#2249], [#2260], [#2303]).
- **One panel for what waits on you.** The header shows one quiet
  **Waiting** count for every project, in place of the old pill with Next.
  Its panel groups the waiting items by project, with the project on screen
  first. It docks beside the board where there is room and floats otherwise. Each row names the waiting agent's role in that role's
  colour, how long it has waited and why, with **Dismiss** on every row and
  project, and **Allow once** / **Deny** inline on a permission prompt. An
  item whose cause is gone leaves by itself. The orchestrator's open
  questions in its report log are the same items: resolve one in either
  place and it is resolved in both. On the phone the ⚠ sheet groups the
  same way ([#2256]).
- **"Asks you".** An optional switch in the board's ⋯ menu, off by default,
  sends the last message of each agent's turn to a small model on OpenRouter
  to spot a question for you. The agent's card then says «asks you» with its
  role, and the report log gets a line with a jump link. It needs your own
  OpenRouter key, and a monthly cap (USD 1 by default) limits what it
  spends ([#2251]).
- **A task's image album.** A card whose agents made renders or screenshots
  gets an **Images** button with the count and a dot for new ones. The album
  shows every image from the task's conversations and pipeline stages,
  newest first and grouped by stage, and opens each one in the full-screen
  viewer ([#2253]).
- **Ask the orchestrator in parallel.** While the orchestrator is busy with
  a turn, **Ask in parallel** (Ctrl/⌘+Shift+Enter) in its composer sends a
  side question to a copy of it. The copy answers with the orchestrator's
  authority, works live in its own block inside the orchestrator's chat,
  then folds to one line with links to what it touched. It cannot deploy or
  rotate the orchestrator ([#2248]).
- **Anthropic-compatible provider accounts.** Under Claude accounts, **Add
  compatible provider** takes a base URL, a token and model IDs for any
  service that speaks the Anthropic Messages API. Claude Code launches and
  resumes on that account use the provider and its models. The token is
  stored in a file only you can read and never appears in any answer
  ([#2262]).
- **Undo and redo on the board.** On the desktop board, Ctrl+Z / ⌘Z undoes
  your own task moves, text edits and hides, and Ctrl+Shift+Z or Ctrl+Y
  redoes them. Every such edit shows a receipt with Undo. If someone else
  changed the task in the meantime, nothing is undone and the receipt says
  so ([#2234]).
- **Task priority.** A task can be high, normal or low. High tasks sit at
  the top of the Inbox and low ones at the bottom, and the card shows a
  small arrow for high and low. Set it from the card's ⋯ menu, or the task
  sheet on a phone ([#2229]).

### Changed
- **A readable pipeline graph.** A review loop now folds under the stage it
  belongs to, as a strip with the fix stage, its state and the rounds as
  dots, instead of a wire looping around the graph. Every node shows its
  true state, and the attempt caption appears once. The graph on a card is
  one column that never gets wider than the card ([#2277]).
- **Claude stages keep going through a usage limit.** When a Claude
  pipeline stage hits its account's session limit, Delegatus moves the
  conversation to another allowed account of that project and continues it
  there, with the same conversation, worktree and review round. A stage whose
  account you chose yourself stays on it ([#2285]).
- **Merge when the review passes covers more pipelines.** Pipelines whose
  review stage passed are now queued for merge, including older review and
  design-review plans. A final read-only stage that committed its output
  locally no longer blocks the merge ([#2288]).
- **Board layout.** On the desktop board an empty column folds to a narrow
  strip and opens when the mouse rests on it or a card is dragged over it.
  A narrow column widens by itself when the mouse rests in it, or when you
  focus one of its agents from the rail. The orchestrator's report log opens
  beside its chat only where the chat keeps enough width ([#2228], [#2233],
  [#2300]).
- **Messages from agents are labelled.** A message that an agent, an
  orchestrator, a pipeline or Delegatus delivers into a conversation shows
  as an agent card with its sender's role, project and a link to the
  sender, never as your own turn ([#2265]).
- **Models are sized to the task.** Builders and reviewers take a small-change
  tier that runs a lighter model. A docs builder (README, docs, public text)
  starts on Claude Opus, and its fix rounds run a lighter model. An
  orchestrator, architect, reviewer or verifier that an agent launches never
  runs on Sonnet or Haiku; a launch you make yourself keeps the model you
  chose ([#2246]).
- **Agent prompts fit any project.** Every role's standing instructions
  now describe practices and name no language, framework or deploy of their
  own, GitHub issues are used only where GitHub is set up, and each stage
  reports with one shared set of verdicts ([#2301]).
- The orchestrator's wakes wait until it is idle instead of arriving in
  the middle of a turn ([#2293]).
- The README is rewritten in plain language on the same structure ([#2239]).

### Fixed
- **Agents keep their Delegatus tools across a release.** An agent's
  connection to the Delegatus MCP server used to close during a release
  restart and stay closed. It now reconnects to the new release, answers
  with a retryable error during the gap, and follows a self-updated install
  to its new release. If it stays broken, the orchestrator is offered a
  rotation instead of more wakes ([#2267], [#2271]).
- **A failed web restart no longer stops your agents.** If a new release
  and the one before it both fail to start, the web server reports failed
  and the runtime host that runs every agent stays up ([#2289]).
- **Finished agent hosts free their resources again.** A host whose agent
  finished long ago used to stay running because of its old launch record.
  Once its launch has settled and it has been idle past the age threshold,
  it is retired like any other idle host ([#2291]).
- **Accounts.** An account whose Codex usage limit was reset early is
  usable again right away rather than refused until the old reset. A
  conversation stuck in a migration that could never start finishes, and
  sending a message no longer moves an agent off the account it was placed
  on ([#2294], [#2295]).
- **Pipelines.** A stage's worktree uses the pipeline's delivery branch,
  retry keeps commits and uncommitted files, and publication stops with a
  clear next step when the local and remote branches diverge. A stage
  report refused while the store was busy can be sent again. Graph edits
  have a typed MCP schema. Pipeline commits get a fallback author when the
  machine has no git identity. A replaced orchestrator can no longer
  control pipelines, and rotation keeps its standing instructions unless new
  ones are given ([#2273], [#2281], [#2282], [#2283]).
- **Deploys.** A team install's sign-in answer no longer fails the deploy
  health check, and a release loads pipelines recorded with older verdicts
  ([#2263], [#2286]).
- The orchestrator's context meter reads correctly after a message with many
  pasted images, instead of showing about 100 % and urging a rotation
  ([#2297]).
- Agent skills stay available after a pipeline worktree is removed, because
  the CLI links them from the main checkout ([#2241]).

## [1.5.0] — 2026-09-25

### Added
- **A first run starts with the orchestrator.** Until an install has had an
  orchestrator, the Overview opens on one band, "Start with an orchestrator",
  above the columns (above the tabs on the phone). The setup guide is three
  numbered steps that end on a running orchestrator: Engines, Project and
  Orchestrator. Orchestrator names the project and the engine, model and
  account it will run on, each with Change. If something is missing (no
  project, no engine connected, or a signed-out account) it says what, and
  otherwise Create starts the orchestrator in one press. Agents, Phone, Voice
  and Check stay in the same dialog under "Later, any time". The
  orchestrator's draft now reads plainly: one sentence on what it does, an
  example of what to write to it, one "Runs on" row, and its instructions
  folded. A new project opens on its Board ([#2212]).
- **An interface walk.** On a new install, once its orchestrator is live, a
  three-stop walk points at its composer, the board and «Needs you», and ends
  on "Give it the first task". It runs once by itself. Start it again from
  «Interface walk» in the rail menu or the phone's board menu ([#2212]).
- **The orchestrator's report log sits beside its chat.** On the desktop
  board the seat has a Reports column to the right of the chat, which a toggle
  in the seat's head hides. On the phone a button in the seat conversation's
  bar opens it. Each report shows its time, its kind (completed, failed,
  blocked, question, review verdict, status) and its text, with issue and PR
  numbers and board cards as links. New reports arrive live and are marked
  new, and Show older pages back. A per-project **Bridge reports** switch in
  the board's ⋯ menu (and the phone's ⋯ sheet) turns them off. While it is
  off, the orchestrator files nothing and voice relays nothing, and the
  reports already stored are kept ([#2214]).
- **Merge when the review passes.** A per-project setting in the board's ⋯
  menu, off by default. When it is on, Delegatus merges each lane whose
  reviews passed, one at a time per repository. It waits until the head's
  checks have all arrived and finished green, brings a branch that is behind
  up to date, and never resolves a conflict. The lane reads "waiting for
  checks · 12m", "updating from main", "merge stopped" or "merged". A stopped
  merge reaches «Needs you» with its reason, and you can Leave the PR open or
  Try the merge again (`retry-merge` in `pipeline_action`). The orchestrator
  follows the same setting: with it off, it reports "PR ready" and merges only
  when you ask ([#2206], [#2208]).
- **A pipeline can finish its task.** Mark a lane "Finishes the task" from its
  ⋯ menu, the draft editor or `create_pipeline` (`finishesTask`), and the task
  moves to Done once that lane has finished: when it completes, or, with the
  merge setting on and a PR on the lane, once that PR is merged. While another
  pipeline on the task is still open the card says "Done waits for N more
  pipelines", and a task you reopen stays open ([#2208]).
- **Worktrees of merged lanes are removed automatically.** An hourly sweep
  removes a linked worktree once a merged pull request has its branch, and
  the local branch with it. It keeps any checkout that is still in use, has
  uncommitted or unmerged work, or holds ignored files a build cannot
  recreate, and records each reason in `state/worktree-sweep-report.json`.
  Conversations from a removed worktree still group under their repository.
  `DELEGATUS_WORKTREE_SWEEP=0` turns it off, `dry-run` only reports
  ([#2205]).
- **Temp directories stop filling the disk.** Test runs and pipeline stages
  remove the temp directories they make, and an hourly sweep removes
  Delegatus's own stale `llv-*` directories that nothing uses from `/tmp`,
  `/var/tmp` and the state's `scratch` directory, never a pipeline worktree.
  `DELEGATUS_TEMP_SWEEP_MAX_AGE_HOURS` sets the age (default 24, `0` turns it
  off) ([#2197]).
- **A rail of the open agents on the desktop board.** A strip beside the
  columns lists every agent opened in a card, with its role's emblem and
  colour, a short name and a live dot. One click jumps to that agent, × closes
  it, and Alt+J / Alt+K step between them. When space is short it shrinks to a
  count that opens the same list ([#2181]).
- **Activity: your time and your agents' time.** The Activity page (rail
  menu) shows the hours you spent and the time your agents worked, per day and
  per project, over Today, 7 days or 30 days. It records itself as
  transcripts are indexed and pulls other hosts over ssh. Filter the whole
  page to one project from its row or the Project picker. Agent time from a
  host that was not read shows as a lower bound, and your time there as
  Unknown ([#2126], [#2159], [#2164]).
- **The image viewer walks a conversation's pictures.** With a picture open,
  ←/→ or the edge buttons step through every picture in that conversation
  with its position shown (`12 / 26`), and a click on the dimmed area closes
  it ([#2149]).
- **Every new task gets an icon and a colour.** `create_task` takes `color`,
  and the orchestrator picks both by one shared rule. On the phone, task cards
  now lead their title with the task's icon in its colour ([#2155],
  [#2192]).
- **A permission request you can answer.** When Claude asks for a tool in
  your own conversation or an orchestrator's, «Needs you» names the tool, the
  command and the reason, with Allow once and Deny. An unanswered request is
  denied after 10 minutes. Agents answer with `conversation_action`
  `permission` ([#2216]).
- The orchestrator seat on top of the board has a width grip: drag it, use
  ←/→, or double-click for the default. The width is kept per project
  ([#2191]).
- `update_task` edits one line of a task's details (`replaceLine`,
  `removeLine`, `appendLine`), `GET /api/tasks?project=` returns one project's
  tasks, and `pipeline_action` `retry-stage` works with the stage name alone
  ([#2145]).

### Changed
- **After the last review round the builder fixes once more and the lane
  completes.** A lane used to stop and wait for you whenever that fix changed
  code. The findings nobody re-reviewed stay on the lane, which shows "Last
  fix not re-reviewed". "When the rounds are spent" offers *Fix, then
  continue* (the default) or *Fix, then wait for me*. A new `review-loop`
  stage is stored as a reviewer and its fix stage ([#2199], [#2200]).
- **A lane parked on a review says why in one line** and answers in plain
  words: Accept as is (`accept-head`) or Review again, and for a stage that
  stopped before fixing, Accept without review or Review again. Close moved to
  the lane's ⋯ menu ([#2200]).
- **Interface polish.** Agent answers read at a comfortable line length, and
  replies are wider than your own bubble. The Stages sheet draws each stage
  once. A board card's lane actions live in the card's one ⋯ menu, and the
  card drops its status pill because its column already says it. On the
  phone, messages, the composer, Bash cards and the task screen are tidier.
  Presses and folds animate, except under reduced motion ([#2160],
  [#2191]).
- **Board order.** In every column, cards with a working agent come first,
  then the most recently worked, then the rest ([#2156]).
- **Launches check sign-in first.** On a signed-out account the launcher and
  the orchestrator draft say so and offer "Sign in to Claude first", which
  opens the account's Sign in, and they launch nothing ([#2211]).
- **A quiet CLI.** `bunx delegatus-cli` prints its banner and URL first and
  nothing else. Set `DELEGATUS_DEBUG=1` for the startup diagnostics. The
  README opens with a five-step Quick start, and `docker compose` no longer
  needs a `service.env` ([#2178]).
- Role defaults: the prod-auditor runs at high effort, and switching a role
  between Claude and Codex maps it to the GPT-6 models ([#2174]).
- The README leads with what Delegatus is for, and its screenshots render on
  GitHub the way they look in the app ([#2138]).

### Fixed
- **The board scrolls smoothly on large boards.** On a screen at normal
  pixel density, Chrome scrolled the desktop board's page and columns on the
  main thread, so on a board of 173 cards every scroll frame waited for a
  repaint and about half of them (50–57 %) did not move the content. The
  board now scrolls on the compositor: no scroll frame waits for the main
  thread, at most 0.1 % fail to move, and the median delay from wheel to
  paint drops from 18–30 ms to 10–16 ms ([#2219]).
- **Unanswered permission requests no longer wedge a stage.** Claude asks for
  a tool even with permissions bypassed when its safety check flags a command,
  and nothing answered, so the turn waited forever and read as
  "provider_throttled". In a pipeline stage or a delegated agent the request
  is now denied at once with the reason, and the turn goes on. "Throttled" now
  shows only when the provider itself retried ([#2216]).
- **A failed launch stays visible and leaves the task where it was.** The
  task goes back to Inbox, the failed row stays on the card with Open and
  Dismiss, and «Needs you» shows the launch's own error ([#2211]).
- **Newcomer blockers.** Claude sign-in starts for a Claude Code installed
  from npm, a reload shows the current sign-in state, and Create
  orchestrator right after Create project works ([#2186]).
- A fresh install no longer lists another setup's Claude background tasks
  under an "Unresolved project" ([#2180]).
- The desktop «Needs you» counter counts lanes waiting on a decision, as the
  cards and the phone badge already did ([#2133]).
- A card lists a launch as "did not start" only when it really did not start,
  and two or more fold behind one row with Dismiss all ([#2142]).
- After a deploy, a stage the release cut keeps going: a builder's attempt
  stays open, a cut review re-runs on the same head, and a launch caught by
  the handover is relaunched ([#2147]).
- Idle Codex hosts are stopped again after their idle hours ([#2141]).
- The note Delegatus sends to resume an interrupted conversation after a
  restart no longer counts as your input ([#2131]).
- **The Update page's changelog reads as formatted text.** Bold, code and
  links render instead of raw Markdown, PR references open their pull
  requests in a new tab, and each entry shows its lead with the rest behind
  More, never cut inside a span ([#2158]).

### Security
- Dependencies with published advisories were upgraded, and the audit passes
  with an empty allowlist ([#2195]).

## [1.4.0] — 2026-09-24

### Added
- **The phone board is the desktop's kanban.** Inbox, Assigned, Blocked and
  Done are tabs over a pager you swipe between, with the desktop's cards and
  counts. Each tab marks the cards agents are working on and the ones that
  need you, and those are pinned to the top. A long press opens a card's
  sheet: move it to another column, hide it, dismiss what it asks, or open its
  first agent, with Undo. Done opens twenty cards at a time
  ([#2096], [#2083]).
- **The phone Overview is the same kanban across every project.** Like the
  desktop Overview it shows live work only, and its ⚠ badge is the sum of what
  the tabs mark. The ⋯ menu lists the tasks you hid, each with Show
  ([#2107]).
- **A task screen on the phone.** A tap on a task opens it: the title (tap to
  edit), its pipelines with what needs you first, a question or plan waiting
  on you, its links, agents, details and earlier attempts. The status pill
  moves the task between columns, with Undo ([#2100]).
- **A pipeline opens as its stages on the phone.** Passed stages fold into one
  row, the running stage shows its engine, model, role and latest line, and a
  decision is answered inside the stage it stopped on: Skip or Retry the
  stage, or Close the lane or allow One more round when the review budget is
  spent ([#2095]).
- **Conversations open full screen on the phone** from every board, the
  Overview included, and ‹ brings you back to the column and scroll position
  you left ([#2107]).
- **Back on the phone follows the path you took.** Every screen and every
  sheet is one step in the browser history, so the browser's Back, the bar's
  ‹ and the iOS edge swipe each go back exactly one step. A screen comes back
  with its column, scroll position and open sections. Links, notifications
  and search results open over the screen you were on, and each screen has its
  own URL, so a reload lands on it again ([#2109], [#2120]).
- **Task icons.** Every desktop task card draws an icon from
  [lucide](https://lucide.dev) before its title. Pick one by clicking the
  icon, from the card menu's «Icon…» or with `I`; a task without one shows the
  icon its title suggests. `create_task` and `update_task` take `icon`
  ([#2104]).
- **PR and issue chips** on pipelines and task cards: the pull request's number
  and state (open, draft, merged or closed), the issues it closes, and
  "no PR" for a lane whose branch has none yet. One click opens GitHub.
  Attach or detach one by hand from the ⋯ menus, or through
  `pipeline_action` (`attach-link`, `detach-link`) and `update_task`
  (`attachLinks`, `detachLinks`); `get_pipeline` and `get_task` return
  `workLinks` ([#2068]).
- **Every card that needs you says why:** the question's own header, "plan
  approval", "permission prompt", "message not delivered", "needs a decision
  · ‹stage›" or "review budget spent · ‹stage›". One click on ✓ clears the
  card, with Undo, until something new asks. On the phone it is a ✓ on the
  card and Dismiss in its long-press sheet. Agents clear cards with the new
  `dismiss_attention` MCP tool, which only the operator's own session and the
  project's orchestrator seat may call; a worker agent is refused ([#2118]).
- **`request_attention` reaches a phone as a quiet notice** when no desktop is
  open. The screen you are reading does not move; the ⚠ badge gets a dot and
  its sheet lists the request under "From your agents" ([#2118]).
- **A Telegram bot account for agents.** Paste a BotFather token in the
  Telegram panel (on the phone, under Accounts), then switch on, chat by chat,
  where agents may post. Agents list those chats with `telegram_bot_chats`,
  post with `telegram_bot_send`, which reaches allowed chats only, names the
  conversation that sent it and never posts twice for one `clientRequestId`,
  and read what the bot received with `telegram_bot_messages`. A bot sees only
  messages sent after it joined, and in a group it sees all of them only with
  privacy mode off or as an admin. The personal-account connector works as
  before ([#2125]).
- **Images an agent looks at appear in its conversation** as thumbnails that
  open full screen, for Claude, Codex and Copilot, on the phone and the
  desktop, while the turn runs and after it. A picture that is no longer on
  disk says so ([#2079]).
- **Delegatus shows its own memory.** Resources lists the web server, the
  runtime host and their workers apart from the agents, in the footer and the
  panel. The phone gets the resources footer, at the foot of its projects
  sheet ([#2116]).
- **Loading looks like what it loads.** The phone paints its own layout and the
  project's name at once, skeletons take the shape of the board, feed and
  lists they stand in for, and the last board is shown from cache while it
  refreshes (an unchanged one costs an empty `304`). During a deploy the
  header says "reconnecting · showing 13:40", and the red alert waits for a
  minute of failures ([#2076]).
- `/favicon.ico` serves the Delegatus emblem ([#2073]).

### Changed
- **Lighter desktop task cards.** A pipeline on a card is one row with no frame
  of its own: its state and age, the chain of stage pills with the PR chips at
  the end, and the answer in place when the lane waits on you (Skip or Retry
  the stage, Close or One more round). The activity line and the framed
  conversation tiles are gone. The phone draws its pipelines from the same
  block ([#2086]).
- **Waits that ask nothing of you no longer count as "needs you":** a rate
  limit, a stalled turn, a paused lane, and a message still being delivered
  for less than 30 minutes. They keep their words on the card ("stalled ·
  37m") without the badge or the count ([#2118]).
- The feed's jump-to-latest control sits in its own row between the feed and
  the composer, so it never covers a line of text ([#2083]).
- A Deployer whose brief quotes your go and lists the approved steps runs
  those steps without asking again, and an approved in-place rolling restart
  proceeds one replica at a time. Without that approval it still plans,
  validates and stops ([#2090]).
- The orchestrator mandate (v23) and the role prompts were revised for Opus 5.5
  ([#2101]).

### Fixed
- **No more «Untitled task» ghost cards.** Helper and probe conversations no
  longer create tasks, an orchestrator seat's launch gets a named task, a task
  that never got its name shows its conversation's first line, and a card
  counts only conversations that open. A launch that never started
  is listed as «Launch did not start» with Dismiss, and a failed launch shows
  at once as «Launch failed» with its error and a way to Retry.
  `scripts/settle-ghost-tasks.ts` settles the cards left from before, dry run
  first ([#2122]).
- **The board only moves forward.** An answer built from older data than the
  screen already shows is never painted, so counts no longer jump back and a
  closed lane no longer reappears under Needs you ([#2083]).
- A lane cleared on the phone no longer marks its desktop card or counts in
  the header ([#2118]).
- **Messages sent while an account switch waits are kept.** They are delivered
  after the switch, on the new account, in the order they were sent, with
  their text. Before, the switch failed them and emptied their text
  ([#1713]).
- **A completed pipeline's last stage host is stopped** like the others; it
  used to keep running. A host-retirement sweep that retires nothing for a day
  now raises a board signal naming what refused it ([#2114]).
- **Resources are current again.** The collector had failed on every refresh
  since 2026-09-20 and kept serving that day's sessions as if they were
  current. Rows kept from a failed refresh are now marked stale with the time
  they were captured, an empty table after a failed refresh never reads as "no
  agents running", and Copilot sessions are counted ([#2116]).
- **Self-update recovers when the remote moves after the check.** The failed
  step offers Check again, then Update to the newly checked commit with its
  changelog, also after a restart ([#2099]).
- The orchestrator seat wakes for lanes that completed on their own and for
  pull requests opened from a lane's delivery branch ([#2082]).
- An agent-registry write that keeps losing to other writers finishes within
  a bounded number of retries ([#2089]).
- On the phone, a conversation no longer keeps an empty band under its
  composer after a screen slides in ([#2107]).

### Removed
- The systemd install path. Docker is the only way to run Delegatus as a
  service: the legacy tmux supervisor unit
  (`deploy/systemd/agent-log-viewer-legacy-tmux.service`), its installer and
  its session bootstrap script are gone, with the docs that described them.
  `bunx delegatus-cli` and `npm i -g delegatus-cli` are unchanged. When a
  retired unit file is still in `~/.config/systemd/user`, `delegatus` prints
  how to stop and remove it and how to install with Docker, then starts as
  usual ([#2112]).
- The phone's old task editor, and with it the phone's Delete task button and
  its raw assignment list. The task screen replaces it; hide a task from the
  board instead ([#2100]).

## [1.3.0] — 2026-09-23

### Added
- **GitHub Copilot as a third engine.** Start a Copilot agent from the agent
  draft or `spawn_agent`, pick its model and effort, send to it, interrupt it,
  resume it and read its conversation the way you read a Claude or Codex one.
  A message sent during a running Copilot turn interrupts it and starts the
  next turn, and a model or effort change restarts the agent on the same
  session. Each managed Copilot account has a home of its own, signs in with a
  device code from the Accounts panel and shows its monthly allowance in the
  limits footer, and Copilot agents get the Delegatus MCP tools, on Docker
  installs too (#2032, #2039, #2049, #2053). This entry was missing from the 1.3.0 notes and was
  added with 1.4.0.
- An **Update** surface, reached from the rail menu and the phone's board
  menus beside the setup guide. It checks the canonical repository for a newer
  `main`, shows the commits and changelog entries between the running release
  and the new one, and updates the install in one of two ways, decided by the
  server from what the install says about itself. A managed Docker install
  (runtime host with Viewer deployments on) deploys the exact revision the
  check showed through the runtime host's own deployment, and the surface
  follows its phases until web has switched and the runtime host has handed
  itself over. A git checkout started by `agent-log-viewer` builds the new
  revision in a release directory of its own through five live steps (fetch,
  check out, install, build, ready), never where the running processes serve
  from, and then restarts web and the runtime host onto it as two separate
  actions, the second behind an inline confirmation. The launcher performs
  those restarts from PIDs it recorded, and falls back to the release it
  replaced when the new one does not start. Only the operator can update or
  restart: an agent presenting its capability is refused. English and
  Ukrainian (#2007).

### Changed
- The product is Delegatus, published on npm as `delegatus-cli`. Its bins are
  `delegatus` (also `dlg`) and `delegatus-mcp`. `agent-log-viewer` and
  `agent-log-viewer-mcp` keep working and say once that the command was renamed. The repository moved to
  `github.com/Latand/delegatus`; GitHub redirects the old name, so existing
  clones, the self-update check and deploys keep working, and a seat recorded
  under the old repository name still deploys the Viewer.
- Board placements are stored in SQLite (`state.sqlite`, collection `board`),
  one row per project, instead of `board.json`. A pin, a hidden group or a
  view-mode change commits only that project's row in one transaction, so a
  crash can no longer leave the whole board zero-filled or half-written, and one
  project's write never rewrites another's bytes. On first start the existing
  `board.json` is imported and verified by row count and digest, then kept as
  `board.json.imported-<release>`; a directory with a README takes its place
  (#1870).
- A `board.json` that cannot be parsed at all (empty, NUL-filled or truncated)
  is kept as `board.json.unreadable-<time>` and the board starts empty with a
  logged incident, instead of every board request failing.
- Account state is stored in SQLite (`state.sqlite`, collection `accounts`)
  instead of eight JSON files: the Claude and Codex account registries with
  their retirement and removal journals, the account↔project bindings, the
  out-of-pool choice journal, the spawn admission fences, the in-flight Claude
  and Codex login operations, and the account mutation revision. A write
  commits only the rows it changed, in one transaction, so a crash can no
  longer leave a zero-filled or half-written registry. On first start the
  existing files are imported and verified by row count and digest, then kept
  as `<name>.imported-<release>`; a directory with a README takes each of their
  places (#1870).
- Removing an account now commits its registry row, its retirement record and
  its removal journal step in ONE transaction, together with the mutation
  revision that admits them. The revision is the collection's own, so
  `account-mutation-revision.json` is gone and a crash can no longer leave a
  fence that moved without the write it admitted (#1857, #1870).
- Conversation-migration operation journals move into the same database, one
  collection per journal root. The roots stay directories, because the
  per-operation lease that guards them has to be claimable while the database
  is busy (#1870). A release rolled back through the fence gets every journal
  written back as the file it knows, and whatever it journals while it runs is
  folded back into the collection at roll-forward.
- An account store whose file could not be read at the import is recorded as a
  gap rather than imported as empty, and each owner answers as it always did: a
  binding record refuses every read and names the file that was kept, a
  registry reports itself corrupt and refuses mutations, and the out-of-pool
  journal — which nothing consults to decide anything — reports nothing. The
  first successful write clears the gap.
- A state-mutating startup step — the first-boot import of any moved store, its
  rollback mirror, the copy-once move of the legacy state directory — runs only
  in the serving Viewer's release activation, or against a state directory the
  caller named itself. It never runs while Next.js collects page data for a
  build, whatever else is true. A build in a checkout used to resolve whatever
  state directory it found and import it out from under the running Viewer
  (#1905).
- An import record that names no release, in a state directory that has a
  release target, was written by a process that did not own the release, so the
  legacy file still standing beside it is re-imported over those rows rather
  than merged into them (#1905).
- Attention requests, reply suggestions and per-project seat tick settings are
  stored in SQLite (`state.sqlite`, collections `attention`,
  `reply_suggestions` and `seat_tick_settings`) instead of `attention.json`,
  `reply-suggestions.json` and `seat-tick-settings.json`. A write commits only
  the rows it changed, one per request, set, admission receipt or project. The
  attention and suggestion revisions carry on from the numbers the files held,
  so `request_attention` never sees its revision move backwards, and replays
  keyed by `clientRequestId` or by a message key still find their first answer
  after the move. On first start each file is imported and verified by row
  count and digest, then kept as `<name>.imported-<release>`; a directory with
  a README takes its place. A file that cannot be parsed at all is kept as
  `<name>.unreadable-<time>` and that store starts empty with a logged
  incident (#1870).

### Downgrading
- A version older than this one cannot read the SQLite account state and fails
  on the directories left where its files were, naming the path. Upgrade again
  to recover. Replacing a directory with its `<name>.imported-*` copy also
  works, but loses account changes made since the upgrade. Deployed releases
  rolled back through the release fence get every file written back for them
  automatically — the eight account stores and each conversation-migration
  journal alike — and the changes they make are merged at roll-forward.
- A version older than this one cannot read the SQLite board and fails on the
  `board.json` directory, naming the path. Upgrade again to recover. Replacing
  the directory with the `board.json.imported-*` copy also works, but loses
  board changes made since the upgrade. Deployed releases rolled back through
  the release fence get a fresh `board.json` written for them automatically.
- A version older than this one cannot read the SQLite attention requests,
  reply suggestions or seat tick settings, and each finds a directory where its
  file was. Only attention fails at once: its reads error with EISDIR, naming
  the path. The older reply-suggestion and seat tick readers treat any
  unreadable file as empty, so that version shows no drafts and runs every
  project on the default tick (a project whose tick was turned off ticks
  again) until its next write fails on the directory. Upgrade again to recover. Replacing a directory with its
  `<name>.imported-*` copy also works, but loses the changes made since the
  upgrade. Deployed releases rolled back through the release fence get all
  three files written back for them automatically, and the changes they make
  are merged at roll-forward. The runtime host must run this release before
  the Viewer is promoted to it, so that a rollback through the host's
  deployment adapter writes those files back.

## [1.2.2] — 2026-09-19

### Changed
- The task board is stored in SQLite (`state.sqlite`, collection `tasks`)
  instead of `tasks.json`. A write commits only the tasks it changed, in one
  transaction, so a crash can no longer leave a zero-filled or half-written
  board. On first start the existing `tasks.json` is imported and verified by
  row count and digest, then kept as `tasks.json.imported-<release>`; a
  directory with a README takes its place (#1870).
- A `tasks.json` that cannot be parsed at all (empty, NUL-filled or truncated)
  is kept as `tasks.json.unreadable-<time>` and the board starts empty with a
  logged incident, instead of every task request failing.

### Downgrading
- A version older than this one cannot read the SQLite board and fails on the
  `tasks.json` directory, naming the path. Upgrade again to recover. Replacing
  the directory with the `tasks.json.imported-*` copy also works, but loses
  task changes made since the upgrade. Deployed releases rolled back through
  the release fence get a fresh `tasks.json` written for them automatically.

### Fixed
- An orchestrator seat is woken when an agent it spawned outside a pipeline
  finishes, within one check interval, and a child whose transcript cannot be
  read is named with its reason instead of being counted silently (#1881).
- The account removal dialog gives each refusal its own message and says what
  was moved on success (#1857).

### Added
- First-run setup guide: connect engines, choose which engine, model and effort
  each role runs on with cost hints, and a plain refusal when a stage names an
  engine that has no signed-in account. Shipped defaults are unchanged (#1876).
- The orchestrator mandate lists each role's engine, model, effort and access
  from the live role registry (#1880).
- Stage conversation cards lead with the stage and its attempt; the role preset
  is secondary (#1865).

### Upgrade and verification
- Install with `npx agent-log-viewer@1.2.2 --no-open`, or
  `bun install -g agent-log-viewer@1.2.2`.

## [1.2.1] — 2026-09-19

### Fixed
- A project whose folder gains a git origin after first use keeps one identity:
  the orchestrator seat, its tasks and its conversations follow the project from
  its folder key to its repository key, so the seat is woken between stages and
  `request_attention` is accepted. Before this the sidebar showed the project
  twice and the seat was never woken (#1874).
- A pipeline stage stays open while its agent still has a background task
  running, instead of settling as failed and parking the lane (#1441).
- Removing an account succeeds and moves its leftovers into a shared archive;
  conversations stay readable (#1857, first slice).
- Conversations a deploy cuts get one durable continuation (#1835, first slice).
- One layering scale for every overlay: the composer's microphone menu and the
  image preview opened from an expanded conversation are no longer covered
  (#1858).

### Changed
- Account switches are instant and optimistic: the pick shows at once and the
  conversation moves with its next message (#1846).
- The project board header is one 48 px bar that says each fact once, with one
  search and one control style; the close-only Undo/Redo buttons are gone
  (#1801).

### Upgrade and verification
- Install with `npx agent-log-viewer@1.2.1 --no-open`, or
  `bun install -g agent-log-viewer@1.2.1`.

## [1.2.0] — 2026-09-19

### Added
- The kanban board is the desktop board: tasks as status columns, conversations
  inside cards, pipeline summaries with stage graphs and past attempts, in-place
  task editing, colours, group hide with a Hidden tray, account chips and
  pickers on stages, and an Overview across every project (#1695, #1699–#1712,
  #1768, #1820).
- Task cards keep agent context in a collapsed Details field, separate from the
  human description (#1834).
- Pipelines are editable graphs: a started pipeline's stages and edges can be
  edited, stages report completion through one MCP call, fail edges count their
  traversals, and every stage shows who runs it (#1726, #1730, #1743, #1798).
- The Viewer's own state decides pipeline stages; publishing to GitHub is opt-in
  (#1692). `create_pipeline` answers at once while the controller provisions the
  worktree (#1799).
- Seat tick: the Viewer wakes a project's orchestrator seat when work is owed,
  with controls on desktop and phone (#1681, #1749, #1783).
- Model-tier usage limits: tier lines in the accounts dialog and the limits
  footer, and spawns gated by the model they request (#1833, #1842, #1849).
- Native Codex queue, steering and orchestrator Voice (#1636).
- The phone's runtime sheet covers the screen and shows and picks the account
  (#1795).
- Durable, owner-bound review handoffs between agents (#1578).
- MCP: conversation actions reach live hosts, transcript search returns newest
  matches first with stable paging, and pipeline writes answer compactly with
  stage-level reads (#1829, #1828, #1845).

### Changed
- One control hides the project rail, and one puts the footer and the
  orchestrator panel away (#1819, #1802).
- Role prompts name `stage_report` as the completion channel, carry one
  process-cleanup rule, and tell agents when to stop and ask (#1797, #1770,
  #1843).
- A lane just created shows on the board at once, and `request_attention` lands
  on it (#1836).

### Fixed
- Pipelines survive a deploy and a refused spawn: a cut turn resumes, a refused
  spawn retries, a busy refusal never consumes the request id, and a stage whose
  work is done never parks for an unreadable verdict (#1747, #1750, #1766,
  #1756).
- Message delivery: a refused send stays editable, an unconfirmed admission
  reconciles, a queued message stays queued through account contention, and a
  delivered launch prompt never reads as delivering (#1593, #1830, #1716, #1793).
- Memory and speed: one resident worker serves a burst of file polls, finished
  conversations are no longer re-hosted at boot, and opening a conversation does
  less work (#1814, #1812, #1718).
- Seat and rotation: a rotation that cannot seat a readable successor keeps the
  previous seat, and a refused wake can no longer mute a seat (#1757, #1771).
- Accounts: dead pinned receipts stop blocking removal, and manual account
  choice is restored (#1595, #1618).
- Next.js 16.3.3 security patch (#1588).

### Upgrade and verification
- Install with `npx agent-log-viewer@1.2.0 --no-open`, or
  `bun install -g agent-log-viewer@1.2.0`. Node 20.9 or later and Bun 1.4.0 or
  later are required; the launcher runs the server under Bun.

## [1.1.0] — 2026-09-08

### Added
- Mobile navigation, conversation controls, account limits and attention sheets,
  with readable tool runs and recovery actions (#1439).
- Board task layouts, dormant conversation readers and tool chronology (#1564).
- MCP recovery of send/spawn outcomes under the original request key, and
  project/revision-fenced task positioning (#1536, #1545).
- Native Windows process and runtime-host support (#1201), with platform CI.
  See the README for platform limitations.

### Fixed
- Claude authentication recognizes account-scoped macOS Keychain credentials
  when a credentials JSON file is absent. Login completion, discovery and
  admission share credential evidence while preserving account isolation and
  file safety checks (#1550, #1551).
- Startup recovery shares historical snapshots, preserves adopted writers and
  progress, and quiesces before rollback. Serving readiness works through
  trusted gateways (#1553, #1554, #1556, #1567).
- Uncertain delivery keeps its original identity and recovery controls; closing
  a pipeline preserves survivor evidence until process death is established
  (#1539, #1540).
- Feed scroll anchoring survives asynchronous prepends, adjacent reasoning stays
  readable, and phone recovery controls remain reachable (#1532, #1535, #1522).
- Connection-based access checks and authenticated gateway handling protect
  remote access while allowing token-free localhost (#1503, #1549).
- Monitor accounting records owned-child outcomes across wakes (#1544).

### Upgrade and verification
- Install with `npx agent-log-viewer@1.1.0 --no-open`. Node 20.9 or later and
  Bun 1.4.0 or later are required; the launcher runs the server under Bun.
- Package and CLI names, configuration paths and compatibility identifiers stay
  unchanged. This release packages source through `84885e71`; publication does
  not perform a Viewer deployment.
- Release startup verification runs on Linux with private home, state and port.
  Native macOS browser login and a user's real Keychain remain untested by this
  release smoke. Platform CI and synthetic credential tests have narrower scope.

## [1.0.3] — 2026-08-28

- Added the Darwin process-identity implementation used by the Claude login
  fence (#1258). Account-scoped Keychain recognition follows in 1.1.0.
- Included Viewer-owned orchestrator ticks and structured-host retirement
  (#1252, #1237).

## [1.0.2] — 2026-08-25

- The packaged CLI supervises its runtime host, enabling structured operation
  from an npm installation (#1175).
- Structured spawns provision Viewer MCP and receive updated orchestrator
  onboarding (#1173, #1174).

## [1.0.1] — 2026-08-25

- Shipped standalone worker bundles required by npm installations (#1157).
- Included conversation-generation archiving, bounded runtime snapshots and
  per-project orchestrator panel state (#1144, #1147, #1150).

The 1.0.1–1.0.3 entries reconcile existing immutable npm releases and git tags.
They are summaries; the comparison links retain each release's complete history.

## [1.0.0] — 2026-07-31

### Fixed
- A review relay no longer enqueues a continuation into an implementer whose
  account the provider has parked (#611). Publish-readiness treated a
  process-alive, claim-owned structured host as ready to receive a turn without
  asking whether the provider would take one, so findings relayed to a builder
  sitting at a quota-warning prompt went to a host that could not start the
  turn: the item stayed `queued`, the relay stopped, and the lane went on
  looking alive. Recovering it by hand cost a preserve-commit, a fresh pipeline
  and a reviewer re-attach, three times in one evening. Readiness now consults
  the runtime's own account state — the newest limits provenance and the
  durable quota observation the account controller records, never the
  transcript's prose — and a live host whose account is parked is handed back
  held instead of published; it keeps its process and its claim, because the
  park belongs to the account and a replacement host would start parked too.
  The relay withholds the verdict rather than queueing it and re-attempts at
  the provider's own deadline, so nothing is dropped, no timeout is widened, no
  retry budget is spent, and the message keeps the idempotent identity it would
  have been sent under. The wait is visible while it lasts: the round records
  what it waits on and until when, and the board blocks the flow with that
  deadline instead of drawing a lane that is quietly making no progress.
- An agent asking for the operator's attention reaches the desktop that is
  actually open, and the automatic focus lands (#688). Three things had to be
  true for that and none of them were. Presence — who is looking at the viewer —
  lived in one process's memory, written only by the server that receives the
  browser's heartbeat, so every other process on the machine (the MCP server,
  where the agent's tools run) read an empty map and concluded nobody was there;
  it is now mirrored to the shared state dir, which is also what stops
  `operator_snapshot` reporting no active view while the board is open. A raised
  request now names the views that are open at the moment it is raised, rather
  than filling that list in seconds later on some browser's next poll, so the
  answer the agent gets can say who it reached — a phone, a hidden tab and a
  long-silent view are still named by nobody, because none of them will move.
  And the move itself now finds conversations the board draws inside a container
  — a worker that folded into its parent's stack once it went quiet, a reviewer
  round drawn in its flow's deck — instead of reporting a card on the operator's
  screen as gone: the focus index resolves through the same layout the board's
  own links route through, and a conversation the layout left out entirely is
  asked for through the shell before the handoff gives up. A move that happens
  this way is recorded as the automatic follow it is, and leaves the Back
  control that returns the operator to where they were.
- Agent chips on the conversation canvas report the agent's real output, not
  the state of its process (#669). Chip activity now derives from how long ago
  the conversation's transcript last grew, so a lane appending records every
  few seconds reads as working however stale the snapshot's own activity
  verdict has become, and a host that stayed alive with nothing to say gets its
  own state — «alive but silent» after five minutes of transcript silence, a
  steady warning ring and its own tray dot, told apart from both working and
  finished. What the silence means is settled by the transcript's last turn,
  never by its age: a turn still open keeps the chip amber (an in-harness
  subagent owns no process of its own, so its open turn is what carries a
  six-minute tool call through), while a turn that ended cleanly reads as done
  even with the host still attached — so a delivered worker greys out instead
  of sitting amber beside a genuinely wedged one. The chips carry a ticking
  clock, so a state change settles in place: a wedged host leaves the working
  state with no reload and no new scan, and a batch change (several
  conversations killed at once) settles every chip from the one poll that
  carries it.
- The limits widget labels each quota window by the horizon its data actually
  carries (#606). Codex reports every rate-limit window with its own length, and
  a plan without a 5-hour limit sends its weekly window in the `primary` slot;
  ingestion filed windows by slot, so a weekly number was drawn under the "5h"
  label while the weekly window stayed empty and its chart said "no history
  yet". Windows are now routed by their declared length everywhere they enter —
  the app-server snapshot, the transcript fallback and the transcript backfill —
  with the reset horizon as the fallback evidence when a window declares no
  length, and a rounded length (a week reported as 10081 minutes) still reading
  as its horizon. Snapshots cached before the fix are relabelled on read.
  Rate-limit events carrying no windows at all — other limit families — no
  longer stand in for the account's snapshot, and only a snapshot that names
  some window can claim a horizon is unreported, so a windowless read still
  charts the history it has instead of a generic empty state.
- Multi-gigabyte active transcripts no longer starve the Viewer (#287). One
  process-wide scan coordinator now owns every catalog generation: the HTTP
  files cache, the pipeline watchdog, and the account controller join or queue
  behind a single scan instead of multiplying corpus reads, with pinned
  refreshes holding an exclusive lease so their pin overlay never leaks into
  the shared catalog. The remaining open-ended readers honor hard byte
  budgets — authorship proofs resume from persisted checkpoints at 4 MiB per
  path inside a 32 MiB cycle budget, and lineage needle scans cap one
  candidate at 1 MiB inside a 256 KiB generation budget — proven against
  logical 3 GiB transcripts. Transcript-derived metadata now caches by file
  identity alone, so project-state reconciliation recomputes only the
  project/worktree overlay instead of evicting the corpus-wide cache. Runtime
  host responses settle exactly once and every read-only host request carries
  the caller's abort signal, ending the late `socket.end` writes
  (`ERR_STREAM_ALREADY_FINISHED`) after client timeouts.
- Two #507 final-review repairs. (1) An aged-idle passed stage on a
  cursor-bearing active pipeline stays the ONE real stage conversation card. The
  board ran two independent derivations over the same scan — the idle-worker
  auto-collapse (#112) folding quiet pipeline-stage transcripts into the pipeline
  stack, and the #507 F2 rule keeping every current stage's latest transcript
  full-size — and they disagreed, so a passed stage's card could vanish or
  duplicate beside the stack. `pipelineFullPanePaths` now exposes exactly the
  active-pipeline full-pane set, and `ProjectDashboard` protects it from
  collapse, so each stage projects one surface (a five-stage graph reads as five
  real/placeholder cards) with no worker-stack duplicate; older retries and
  completed/closed pipelines still compact. (2) The mobile stage editor is now a
  real modal that owns keyboard focus. Opened above the phone pipeline dock
  sheet, Tab and Shift+Tab stay inside the editor, Escape closes only the editor
  and returns focus to its trigger, and the sheet beneath yields — coordinated
  through a shared modal-layer stack (`useModalLayer`) so only the topmost layer
  traps focus and answers Escape.

### Changed
- Completed the on-canvas pipeline editor visual contract (#507 review). Three
  repairs finish the pivot to composing the whole pipeline on the canvas as real
  cards: (1) desktop stage editing no longer has a nested form/scroller — the
  pipeline group's override panel keeps only pipeline-level controls (draft
  task/spec/repo, lifecycle, retry/skip) and points to the canvas, so every
  per-stage edit (role, model, prompt, order, connections) happens on the real
  conversation/placeholder cards. (2) A completed stage of an active pipeline now
  stays a full conversation card inside the colored group — `compactPipelineArtifactPaths`
  keeps every current stage's latest transcript full-size and folds only
  superseded retries (and completed/closed pipeline history), and an idle
  completed stage whose transcript is no longer surfaced as a live node stands in
  as a full-size completed card that shows the prompt it ran and opens its
  transcript. A five-stage graph now renders as five real/placeholder cards, not
  one live pane beside compact history stubs. (3) The mobile stage editor now
  portals above the phone pipeline dock sheet (z-[80] over the sheet's z-[70]),
  so it is visible and usable at 390px instead of painting under the backdrop.

### Added
- A recurring conversation monitor that surfaces pending, stalled and untracked
  operator requests (#741). It resolves the current orchestrator through the
  durable single-instance record and addresses it by conversation id, so a
  rollover, restart or model swap cannot orphan it the way the hard-coded
  transcript path it replaces did. Resolution includes a read-only host probe,
  because the mechanism it replaces spent over a day nudging a conversation with
  no live host — and because a send into one would resume it. Unproven counts as
  unresolved: a record with no settled path, a probe that errored, and a send
  that had to resume its own audience all fail the run rather than reporting a
  delivery nobody received. Whenever no live orchestrator resolves, the
  condition lands on the board and the run exits non-zero, never a silent
  success. It reads operator-authored messages over a bounded recent window,
  telling them apart from assistant text, tool output and its own nudges (which
  carry a marker precisely so it cannot read its own report back as a request),
  correlates each concrete request against board cards, pipelines, flows, pull
  requests and issues, and classifies it as completed, in flight, stalled, never
  materialized, or awaiting operator confirmation — with correlation scoped to
  the project the request came from, so another board's work cannot suppress it,
  and an issue number named in passing never retires a request nobody did.
  Staleness is judged on genuine stage and round activity rather than a
  container's age. Gaps become board cards through the Viewer API, each stamped
  with the request's fingerprint, so re-running over the same window creates
  nothing further. Cards summarize and never quote the transcript: what leaves
  the monitor is redacted of credentials, email addresses, home directories and
  absolute paths, including the encoded forms. GitHub issues are never created
  from inferred intent — a request for one is surfaced as an unconfirmed
  candidate. Every run appends exactly one audit line, through the viewer's own
  `/api/monitor/runs`, that tells a clean run from a failed or skipped one,
  carrying fingerprints and counts but no transcript text, path or identity; the
  single-flight lock behind `/api/monitor/lock` is an atomic claim, so two
  overlapping runs can never both proceed. Scheduled with
  `bun scripts/conversation-monitor.ts`; design notes in
  `docs/design/conversation-monitor.md`.
- Background music in the Viewer, and one track across the call boundary
  (#732). The Audio settings now carry two independent switches sharing one
  level: music while using the Viewer, and music during a call — the latter the
  renamed old ambient setting, whose Ukrainian label read as an engineering term
  («фоновий шар») rather than as music. With both on, the same track simply
  keeps playing across the call edge in either direction: no teardown, no
  re-init, no position reset, and speech ducking applies for the duration of the
  call as before. With only one on, the edge that silences the music parks it —
  the voice fades out and the position it reached is retained, so the edge that
  brings it back resumes from there instead of replaying the same opening on
  every call — and the parked voice stays alive for its whole fade, so a call
  that ends inside it returns to that very voice instead of stacking a second
  one over the music still sounding. Only a device that wants no music at all
  (the sound master off, both switches off, no asset) tears the track down. The
  music ducks under whoever is talking, read off the transcript the call already
  produces, with the duck owned per mounted composer so a card nobody is
  speaking in cannot let the music back up over the one they are. Every line a
  call inherits is disqualified as speech the moment it goes live, so the line a
  dropped call left mid-sentence — never marked final, and kept on screen on
  purpose — cannot open the next call already ducked. Ambient
  ownership across conversation cards holds through a keyed card switch: React
  destroys the outgoing card's effects before creating the incoming one's, so
  the last lease going away is settled at the end of the tick rather than on the
  instant — a swipe between conversations never restarts, duplicates or drops
  the track.
- On-canvas pipeline stage reordering (#507). A draft's stage cards carry their
  own move-earlier / move-later controls, so the whole conversation graph is
  composed in place on the canvas — no nested form. Each move is offered only
  when it keeps the chain startable (no review-loop ahead of the first run,
  matching the server guard) and rides the shipped optimistic PATCH echo through
  the new `optimisticReorderStage`, which relinks intentional pass/fail edges by
  identity exactly as the server's reorder does. The on-canvas add affordance now
  extends the chain up to the full 8-stage limit (previously capped at 4), and
  the placeholder card body renders the stage prompt as a bounded, clamped
  preview with no nested scrollbar — the full prompt stays editable in the card's
  configuration disclosure.
- Inferred spawn lineage (#341). `POST /api/spawn` no longer requires `src`
  from authenticated agent callers: the durable parent is inferred from the
  caller's own capability-bound conversation, persisted as registry lineage
  (receipt + edge) with a `parentSource` attribution (`explicit` /
  `inferred-caller`), and exposed in the spawn response as `parent`. An
  explicit `src` still wins and is still rejected when it does not resolve to
  the caller; operator-capability callers without `src` proceed as silent
  roots. Lineage stays conversation-id-keyed, so restart, resume, account
  switch, handoff, and the board projection are unchanged.
- Pathless retry for failed task launches (#334). `POST
  /api/tasks/{id}/spawn` accepts `retryOfLaunchId`, relaunching a failed
  assignment from its durable receipt shape (engine, directory, model,
  effort, pinned account) with a server-minted fresh attempt id — the
  terminal receipt is never replayed and the failed audit assignment is
  preserved. The task card's failed assignment chip and the mobile task
  sheet gain a compact retry-launch control that needs no transcript path.
- Reviewer isolation and bounded, tracked agent nesting (#393). Reviewer and
  verifier sessions keep full filesystem, shell, GitHub, and browser access but
  have zero child-spawn capability: every launch they originate — direct
  `/api/spawn`, pipeline creation, or any future MCP surface routed through the
  registry — is terminally rejected before a child transcript or process
  exists, with a durable typed rejection receipt (`reviewer_origin_spawn` /
  `nesting_depth_exceeded`) and actionable guidance. Every delegated launch
  durably records its role and delegation depth (plus parent, membership,
  account, and engine) before execution, and a new operator-only
  `maxAgentNestingDepth` setting (`GET`/`PATCH /api/spawn/policy`,
  conservative default 2) bounds delegation chains. Resume, restart adoption,
  account switch, and stage retries conserve the recorded identity; reviewer
  resume profiles always deny native multi-agent tools.
- Demo motion pipeline (`bun run demo:motion`, stage B of the demo media
  effort): storyboard-as-data recordings of the four key flows rendered as
  loopable GIFs plus a stitched `docs/media/demo.mp4`, reusing the stage A
  fixture, browser image, and pixel gates. The README now leads with the hero
  GIF and a feature tour; regeneration commands live in
  `docs/media/README.md`.

### Fixed
- Stale structured launches now converge while the server runs (#334): a
  bounded, idempotent reaper-cycle pass turns dead-evidence pending launches
  (no live admission owner, host entry, or runtime session past the timeout)
  into the durable retry-safe `failed` state — recovering instead when strong
  delivery evidence exists — so permanent placeholder spinners and blocked
  composers no longer wait for a replay request or a restart.
- `viewer.snapshot` resolves `spawn:<launchId>` visible paths (#342): a
  materialized launch returns its real conversation (annotated with
  `resolvedFrom`), an unresolved one returns a typed `spawn-stub` with the
  durable launch state in the additive `stubs` array, and `omittedCount`
  covers only genuine budget truncation instead of silently dropping spawn
  placeholders.
- Terminal spawn placeholders retire from the board projection after 24 hours
  (#342): a pure read-model bound (no registry writes, no deletions, restart-
  invariant) that converges the accumulated placeholder baseline while
  receipts, conversations, lineage, transcripts, tasks, and active pane-less
  agents stay intact; recent terminal launches keep their prominent card and
  launch-history tiers.

### Changed
- Current product prose, static page metadata, and the CLI startup banner use
  the `Agent Log Viewer` display name. Compatibility identifiers stay stable:
  the `agent-log-viewer` package and CLI, `LLV_*` variables, `llv_auth`, browser
  storage keys, supported legacy config/cache paths, and the existing repository URL.

## [0.11.2] — 2026-07-08

### Added
- Task curator API: `/api/tasks/curator` surfaces recent real user inputs with
  transcript context and accepts short curated proposals that become board
  tasks with source fingerprints. `GET` scopes to every project or one via
  `?project=`, and returns a `projects` discovery list — so an automation can
  poke the viewer from anywhere and capture all boards or a single one.
- Resource cleanup now has a guarded "kill all agents" control for a deliberate
  clean slate across tracked agent panes.

### Changed
- Automatic task inbox capture is opt-in through `LLV_ENABLE_AUTO_TASK_INBOX=1`.

### Fixed
- Finished Codex worktree sessions under `~/.codex/worktrees/<id>/<repo>` keep
  grouping under the parent repo after the ephemeral checkout disappears.
- Workflow setup no longer reports a just-launched command as "interrupted": a
  short settle window anchored on the launch artifact absorbs the spawn/exit
  race between the pid becoming visible and the exit-code trailer landing.

## [0.11.1] — 2026-07-08

### Added
- Composer send now has a compact context menu with a quick "Yes, continue"
  action, mirroring the microphone backend menu pattern.

### Fixed
- Orphaned workflow records no longer keep missing repositories visible in the
  project rail. A workflow is listed only when its workspace still exists or a
  linked transcript is present in the current scan.

## [0.10.0] — 2026-07-08

### Added
- Docker runtime: a `Dockerfile` and `docker-compose.yml` build `.next` inside
  the image from a clean environment and run the viewer with host parity — host
  network and PID namespace, the real `/home/latand` tree and tmux socket, and
  `nsenter` shims that exec the exact host `claude`/`codex`/`bun`/`uv`/`tmux`.
  Prod runs as the `viewer` service on `127.0.0.1:8898` with
  `restart: unless-stopped`; a `test` profile brings up a second instance on
  another port. Reproducibility, not isolation — see `docs/docker.md`.
- Idle conversation roots now appear in the quiet history list even when they
  head an active group, marked to set them apart from fully-quiet roots.

### Changed
- The prod deployment moved from the `agent-log-viewer.service` systemd user
  unit to Docker Compose; the systemd unit is disabled. `scripts/rebuild.sh`
  now rebuilds and redeploys the container (still verifying the served CSS the
  HTML references returns 200).
- Removed Codex companion-job support. The viewer no longer scans, links, or
  renders `~/.claude/plugins/data/codex-openai-codex/state` jobs — the
  `codex-jobs` root and its parentage linking are gone. Codex spawning was
  never routed through the companion plugin (it uses tmux directly), so
  spawn behavior is unchanged.

### Fixed
- Spawning an agent survives a deleted tmux server cwd: the pane receives an
  explicit `cd` into the target directory before the boot command, so a stale
  server working directory no longer aborts the launch.
- An archived project revives when an agent inside it is running again: an
  idle-but-running conversation un-hides its project instead of staying hidden.

## [0.9.3] — 2026-07-07

### Changed
- Task cards hand off instead of firing. Dropping a task's arrow onto a live
  agent (or clicking a routed target) now seeds that pane's composer with the
  task text and never auto-sends; a removable link records where it was routed,
  and a "detach" action unlinks an assignment. Quiet projects render on the
  canvas with a scheme/list view toggle. Message-feed images referenced by a
  local path embed inline instead of showing as bare links.
- Resumed sessions are matched to their running process. Transcript→pid
  attribution now recognizes `--resume <id>` and `codex resume <id>`, so a
  resumed pane is correctly identified in the viewer.

### Fixed
- Handoff assignments persist. The task store validator accepts the `handoff`
  state, so a task routed to a pane is no longer dropped on the next load.

### Security
- The local image proxy (`/api/image`) is hardened: it rejects cross-origin and
  DNS-rebind requests (same Host/Origin gate as the mutating routes), resolves
  symlinks and re-checks home containment before reading, and no longer serves
  SVG inline (which could run same-origin script).

## [0.9.1] — 2026-07-06

### Changed
- The codebase is English by default: hardcoded Ukrainian strings (API error
  responses, display labels, transcribe messages) and internal `kind`/`project`
  values are now English. The Ukrainian UI locale (`src/lib/i18n/uk.ts`) and the
  CLI's Ukrainian messages are unchanged, so a uk locale still gets a Ukrainian
  UI; only the default and the non-localized internals moved to English.

## [0.9.0] — 2026-07-06

### Fixed
- CLI no longer kills its own healthy server on startup. The readiness probe
  reused the 200 ms poll interval as its per-request socket timeout, but the
  probe hits `/api/files`, which scans every log under `~/.claude` and
  `~/.codex`; past a few hundred conversations that scan takes 250–600 ms, so
  every probe aborted early and the launcher declared a timeout after 15 s. The
  probe now has its own 5 s socket timeout.
- No more "nothing found" flash while the conversation list loads. The sidebar,
  switchboard and mobile focus view showed their empty state on first paint,
  before the first `/api/files` response arrived; they now show a loading
  spinner until the first fetch settles.

## [0.8.0] — 2026-07-06

### Added
- Mobile shell: trimmed pane chips, composer tools folded behind one toggle,
  attention badge in the header.
- Feed copy affordances: inline monospace chips copy themselves on click;
  code blocks and command outputs get a hover copy button, with a clipboard
  fallback for plain-http LAN origins.

### Changed
- Dictation starts faster: mic acquisition overlaps a prewarmed live token.

## [0.7.0] — 2026-07-06

The board fast path — the release that makes the scheme keep up with a dozen
live agents at once.

### Added
- Server-push log tailing: `GET /api/logs/stream` (SSE over `fs.watch` with a
  safety re-stat and heartbeat); the client falls back to batched polling
  automatically when the stream drops.
- Batched channels: one `POST /api/logs` per tick for every visible pane's
  forward read (byte-budgeted), one `POST /api/tmux/targets` for all pane
  target lookups.
- `ETag`/`If-None-Match` on `/api/files` — unchanged payloads come back as a
  bodyless 304.

### Changed
- Incremental feed parsing: each pane parses only appended transcript lines;
  cross-line effects land copy-on-write, so unchanged messages keep identity
  and skip markdown re-render entirely (measured 225× less parse work per
  tick on a 10 MB transcript).
- Panes sleep when they cannot be seen: off-viewport (IntersectionObserver)
  and behind the far-zoom identity labels. Activity dots, questions and
  notifications keep riding the files poll.
- Scanner discovery and link glob scans became cooperative: async walks with
  bounded concurrency and event-loop yields, so `/api/files` no longer stalls
  log responses behind it.
- One shared 128 KB tail read+parse per growing transcript per scan instead
  of 4–6; `/proc` and tmux pane-map memos now outlive the 10 s poll.
- Pane header reworked into two rows: identity + actions on top, metadata
  chips below; cleanup list names sessions by argv session uuid.

## [0.6.0] — 2026-07-06

### Added
- Reasoning level and codex fast/standard toggle on every new-agent surface.
- System resources panel: RAM/swap rail block with per-agent-session memory
  (over tmux pane trees) and a stale-session cleanup panel.
- Microphone engine menu (right-click): pick the transcription backend; a
  visible "starting" state while the recording pipeline connects.
- Chime when a new subagent or agent link appears.

## [0.5.0] — 2026-07-05

### Changed
- Viewer state moved out of `~/.claude` into `~/.config/agent-log-viewer`
  (atomic, retryable migration of the legacy directory).
- npm releases are published from CI on tag push via trusted publishing.

## [0.4.0] — 2026-07-05

### Added
- Agent workflows: multi-step templates (stage → fixer → PR body) with a
  state machine, provisioning, draft cards and a docked strip.
- Task handoff arrow: hand a board task to an agent by pulling an arrow.

### Fixed
- Anchored feed scroll across layout reshuffles.

## [0.3.0] — 2026-07-05

### Added
- Lasso multi-select with ephemeral bulk-action sessions on the scheme board.
- Board tasks: sticky cards over the panes with delivery to agents, mobile
  task sheet with STT/images, minimap task dots.
- Attention queue («needs me») with rail counts.
- Expand any conversation pane to the full window and collapse back.

## [0.2.0] — 2026-07-05

### Added
- i18n (English + Ukrainian) across the UI and CLI.
- Mobile mode: focused conversation, full-screen map, project drawer.
- Live dictation UI and TUI menu cards; the scanner parses waiting TUI menus
  and answers them by key.
- Archived projects.

### Changed
- Scheme-canvas jank cut with many agents: memoized feed, rAF camera,
  smaller panes.

## [0.1.1] — 2026-07-05

### Added
- In-app QR onboarding for phone access; hardened Tailscale flow.
- Unified config dirs; short-lived transcription tokens.

## [0.1.0] — 2026-07-04

Initial public release, packaged as `agent-log-viewer` with a `bunx` CLI.

- Local web UI that tails Codex / Claude Code transcripts into a live
  chat-style feed with a session parentage tree.
- Project scheme canvas: conversations as cards on a pannable, zoomable
  world with parent→child arrows, minimap, review-loop cycles.
- tmux composer: message, interrupt or kill any tracked agent; spawn new
  agents; codex spawn lineage survives process exit.
- Implement→review flows with fresh headless reviewer rounds.
- Remote access over Tailscale behind a token gate.

[Unreleased]: https://github.com/Latand/delegatus/compare/v1.9.1...HEAD
[1.9.1]: https://github.com/Latand/delegatus/compare/v1.9.0...v1.9.1
[1.9.0]: https://github.com/Latand/delegatus/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/Latand/delegatus/compare/v1.7.1...v1.8.0
[1.7.1]: https://github.com/Latand/delegatus/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/Latand/delegatus/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/Latand/delegatus/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/Latand/delegatus/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/Latand/delegatus/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/Latand/delegatus/compare/v1.2.2...v1.3.0
[1.2.2]: https://github.com/Latand/live-log-viewer-next/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/Latand/live-log-viewer-next/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/Latand/live-log-viewer-next/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Latand/live-log-viewer-next/compare/v1.0.3...v1.1.0
[1.0.3]: https://github.com/Latand/live-log-viewer-next/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/Latand/live-log-viewer-next/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Latand/live-log-viewer-next/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Latand/live-log-viewer-next/compare/v0.11.7...v1.0.0
[0.11.2]: https://github.com/Latand/live-log-viewer-next/compare/v0.11.1...v0.11.2
[0.11.1]: https://github.com/Latand/live-log-viewer-next/compare/v0.10.0...v0.11.1
[0.10.0]: https://github.com/Latand/live-log-viewer-next/compare/v0.9.3...v0.10.0
[0.9.3]: https://github.com/Latand/live-log-viewer-next/compare/v0.9.1...v0.9.3
[0.9.1]: https://github.com/Latand/live-log-viewer-next/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/Latand/live-log-viewer-next/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Latand/live-log-viewer-next/compare/714badd...v0.8.0
[0.7.0]: https://github.com/Latand/live-log-viewer-next/compare/v0.6.0...714badd
[0.6.0]: https://github.com/Latand/live-log-viewer-next/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Latand/live-log-viewer-next/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Latand/live-log-viewer-next/compare/9608413...v0.4.0
[0.3.0]: https://github.com/Latand/live-log-viewer-next/compare/3e974b0...9608413
[0.2.0]: https://github.com/Latand/live-log-viewer-next/compare/fc7eccc...3e974b0
[0.1.1]: https://github.com/Latand/live-log-viewer-next/compare/1b5dd63...fc7eccc
[0.1.0]: https://github.com/Latand/live-log-viewer-next/commit/1b5dd63

[#1713]: https://github.com/Latand/delegatus/pull/1713
[#2068]: https://github.com/Latand/delegatus/pull/2068
[#2073]: https://github.com/Latand/delegatus/pull/2073
[#2076]: https://github.com/Latand/delegatus/pull/2076
[#2079]: https://github.com/Latand/delegatus/pull/2079
[#2082]: https://github.com/Latand/delegatus/pull/2082
[#2083]: https://github.com/Latand/delegatus/pull/2083
[#2086]: https://github.com/Latand/delegatus/pull/2086
[#2089]: https://github.com/Latand/delegatus/pull/2089
[#2090]: https://github.com/Latand/delegatus/pull/2090
[#2095]: https://github.com/Latand/delegatus/pull/2095
[#2096]: https://github.com/Latand/delegatus/pull/2096
[#2099]: https://github.com/Latand/delegatus/pull/2099
[#2100]: https://github.com/Latand/delegatus/pull/2100
[#2101]: https://github.com/Latand/delegatus/pull/2101
[#2104]: https://github.com/Latand/delegatus/pull/2104
[#2107]: https://github.com/Latand/delegatus/pull/2107
[#2109]: https://github.com/Latand/delegatus/pull/2109
[#2112]: https://github.com/Latand/delegatus/pull/2112
[#2114]: https://github.com/Latand/delegatus/pull/2114
[#2116]: https://github.com/Latand/delegatus/pull/2116
[#2118]: https://github.com/Latand/delegatus/pull/2118
[#2120]: https://github.com/Latand/delegatus/pull/2120
[#2122]: https://github.com/Latand/delegatus/pull/2122
[#2125]: https://github.com/Latand/delegatus/pull/2125
[#2158]: https://github.com/Latand/delegatus/pull/2158
[#2126]: https://github.com/Latand/delegatus/pull/2126
[#2131]: https://github.com/Latand/delegatus/pull/2131
[#2133]: https://github.com/Latand/delegatus/pull/2133
[#2138]: https://github.com/Latand/delegatus/pull/2138
[#2141]: https://github.com/Latand/delegatus/pull/2141
[#2142]: https://github.com/Latand/delegatus/pull/2142
[#2145]: https://github.com/Latand/delegatus/pull/2145
[#2147]: https://github.com/Latand/delegatus/pull/2147
[#2149]: https://github.com/Latand/delegatus/pull/2149
[#2155]: https://github.com/Latand/delegatus/pull/2155
[#2156]: https://github.com/Latand/delegatus/pull/2156
[#2159]: https://github.com/Latand/delegatus/pull/2159
[#2160]: https://github.com/Latand/delegatus/pull/2160
[#2164]: https://github.com/Latand/delegatus/pull/2164
[#2174]: https://github.com/Latand/delegatus/pull/2174
[#2178]: https://github.com/Latand/delegatus/pull/2178
[#2180]: https://github.com/Latand/delegatus/pull/2180
[#2181]: https://github.com/Latand/delegatus/pull/2181
[#2186]: https://github.com/Latand/delegatus/pull/2186
[#2191]: https://github.com/Latand/delegatus/pull/2191
[#2192]: https://github.com/Latand/delegatus/pull/2192
[#2195]: https://github.com/Latand/delegatus/pull/2195
[#2197]: https://github.com/Latand/delegatus/pull/2197
[#2199]: https://github.com/Latand/delegatus/pull/2199
[#2200]: https://github.com/Latand/delegatus/pull/2200
[#2205]: https://github.com/Latand/delegatus/pull/2205
[#2206]: https://github.com/Latand/delegatus/pull/2206
[#2208]: https://github.com/Latand/delegatus/pull/2208
[#2211]: https://github.com/Latand/delegatus/pull/2211
[#2212]: https://github.com/Latand/delegatus/pull/2212
[#2214]: https://github.com/Latand/delegatus/pull/2214
[#2216]: https://github.com/Latand/delegatus/pull/2216
[#2219]: https://github.com/Latand/delegatus/pull/2219
[#2224]: https://github.com/Latand/delegatus/pull/2224
[#2228]: https://github.com/Latand/delegatus/pull/2228
[#2229]: https://github.com/Latand/delegatus/pull/2229
[#2233]: https://github.com/Latand/delegatus/pull/2233
[#2234]: https://github.com/Latand/delegatus/pull/2234
[#2236]: https://github.com/Latand/delegatus/pull/2236
[#2237]: https://github.com/Latand/delegatus/pull/2237
[#2238]: https://github.com/Latand/delegatus/pull/2238
[#2239]: https://github.com/Latand/delegatus/pull/2239
[#2241]: https://github.com/Latand/delegatus/pull/2241
[#2242]: https://github.com/Latand/delegatus/pull/2242
[#2243]: https://github.com/Latand/delegatus/pull/2243
[#2246]: https://github.com/Latand/delegatus/pull/2246
[#2248]: https://github.com/Latand/delegatus/pull/2248
[#2249]: https://github.com/Latand/delegatus/pull/2249
[#2251]: https://github.com/Latand/delegatus/pull/2251
[#2253]: https://github.com/Latand/delegatus/pull/2253
[#2256]: https://github.com/Latand/delegatus/pull/2256
[#2260]: https://github.com/Latand/delegatus/pull/2260
[#2262]: https://github.com/Latand/delegatus/pull/2262
[#2263]: https://github.com/Latand/delegatus/pull/2263
[#2264]: https://github.com/Latand/delegatus/pull/2264
[#2265]: https://github.com/Latand/delegatus/pull/2265
[#2267]: https://github.com/Latand/delegatus/pull/2267
[#2270]: https://github.com/Latand/delegatus/pull/2270
[#2271]: https://github.com/Latand/delegatus/pull/2271
[#2273]: https://github.com/Latand/delegatus/pull/2273
[#2277]: https://github.com/Latand/delegatus/pull/2277
[#2280]: https://github.com/Latand/delegatus/pull/2280
[#2281]: https://github.com/Latand/delegatus/pull/2281
[#2282]: https://github.com/Latand/delegatus/pull/2282
[#2283]: https://github.com/Latand/delegatus/pull/2283
[#2285]: https://github.com/Latand/delegatus/pull/2285
[#2286]: https://github.com/Latand/delegatus/pull/2286
[#2287]: https://github.com/Latand/delegatus/pull/2287
[#2288]: https://github.com/Latand/delegatus/pull/2288
[#2289]: https://github.com/Latand/delegatus/pull/2289
[#2291]: https://github.com/Latand/delegatus/pull/2291
[#2293]: https://github.com/Latand/delegatus/pull/2293
[#2294]: https://github.com/Latand/delegatus/pull/2294
[#2295]: https://github.com/Latand/delegatus/pull/2295
[#2297]: https://github.com/Latand/delegatus/pull/2297
[#2298]: https://github.com/Latand/delegatus/pull/2298
[#2300]: https://github.com/Latand/delegatus/pull/2300
[#2301]: https://github.com/Latand/delegatus/pull/2301
[#2303]: https://github.com/Latand/delegatus/pull/2303
[#2302]: https://github.com/Latand/delegatus/pull/2302
[#2305]: https://github.com/Latand/delegatus/pull/2305
[#2308]: https://github.com/Latand/delegatus/pull/2308
[#2309]: https://github.com/Latand/delegatus/pull/2309
[#2311]: https://github.com/Latand/delegatus/pull/2311
[#2312]: https://github.com/Latand/delegatus/pull/2312
[#2313]: https://github.com/Latand/delegatus/pull/2313
[#2315]: https://github.com/Latand/delegatus/pull/2315
[#2316]: https://github.com/Latand/delegatus/pull/2316
[#2317]: https://github.com/Latand/delegatus/pull/2317
[#2318]: https://github.com/Latand/delegatus/pull/2318
[#2320]: https://github.com/Latand/delegatus/pull/2320
[#2325]: https://github.com/Latand/delegatus/pull/2325
[#2326]: https://github.com/Latand/delegatus/pull/2326
[#2327]: https://github.com/Latand/delegatus/pull/2327
[#2331]: https://github.com/Latand/delegatus/pull/2331
[#2333]: https://github.com/Latand/delegatus/pull/2333
[#2334]: https://github.com/Latand/delegatus/pull/2334
[#2335]: https://github.com/Latand/delegatus/pull/2335
[#2336]: https://github.com/Latand/delegatus/pull/2336
[#2337]: https://github.com/Latand/delegatus/pull/2337
[#2338]: https://github.com/Latand/delegatus/pull/2338
[#2339]: https://github.com/Latand/delegatus/pull/2339
[#2340]: https://github.com/Latand/delegatus/pull/2340
[#2342]: https://github.com/Latand/delegatus/pull/2342
[#2343]: https://github.com/Latand/delegatus/pull/2343
[#2347]: https://github.com/Latand/delegatus/pull/2347
[#2348]: https://github.com/Latand/delegatus/pull/2348
[#2349]: https://github.com/Latand/delegatus/pull/2349
[#2350]: https://github.com/Latand/delegatus/pull/2350
[#2355]: https://github.com/Latand/delegatus/pull/2355
[#2358]: https://github.com/Latand/delegatus/pull/2358
[#2359]: https://github.com/Latand/delegatus/pull/2359
[#2360]: https://github.com/Latand/delegatus/pull/2360
[#2363]: https://github.com/Latand/delegatus/pull/2363
[#2365]: https://github.com/Latand/delegatus/pull/2365
[#2366]: https://github.com/Latand/delegatus/pull/2366
[#2368]: https://github.com/Latand/delegatus/pull/2368
[#2370]: https://github.com/Latand/delegatus/pull/2370
[#2376]: https://github.com/Latand/delegatus/pull/2376
[#2377]: https://github.com/Latand/delegatus/pull/2377
[#2380]: https://github.com/Latand/delegatus/pull/2380
[#2382]: https://github.com/Latand/delegatus/pull/2382
[#2383]: https://github.com/Latand/delegatus/pull/2383
[#2384]: https://github.com/Latand/delegatus/pull/2384
[#2385]: https://github.com/Latand/delegatus/pull/2385
[#2387]: https://github.com/Latand/delegatus/pull/2387
[#2388]: https://github.com/Latand/delegatus/pull/2388
[#2430]: https://github.com/Latand/delegatus/pull/2430
[#2495]: https://github.com/Latand/delegatus/pull/2495
[#2496]: https://github.com/Latand/delegatus/issues/2496
