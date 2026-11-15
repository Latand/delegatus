# Install and onboarding: a second, independent view

Status: design, no product change. Written 2026-11-10 on the pipeline branch
at `d6414f43`, whose base on `main` is `3192d84b`; every `file:line` on our
side is from that tree. The community launcher was cloned into private scratch
at its head `b2cc436e11affd49496098ac4517b441f3bc2c68` and read as text.
Nothing from it was built or run, and our code was read without starting it.
Five public documentation pages were fetched on 2026-11-10; each is named
where it is used, and §8 lists their addresses.

Order of work. This view was formed from three primary sources: the pinned
specification, the launcher's repository and our own install and first-run
code. My first-run flow and my recommendation for the launcher were written
down before `docs/design/install-and-onboarding.md` ("the first document") was
opened; that note is kept with this stage's private evidence. The first
document was read afterwards, as this branch holds it, and §2 compares the two.

## 0. Originating requirement

Source: the operator's request in the Delegatus seat conversation, 2026-11-10,
about 13:00 UTC. The pinned specification keeps the verbatim message private,
so this is a neutral English paraphrase:

> Someone outside the project built a launcher for Delegatus. Can we think
> about how to build it in? More broadly, design a convenient installation and
> onboarding: first make sure an agent account is set up, then import memory
> from that account, teach that work starts with the orchestrator, perhaps
> create the orchestrator for the user right away, simply ask what they want
> done and explain that this will start an agent. Claude is preferred for the
> orchestrator; when only Codex is available, recommend Claude but run the
> orchestrator on Codex GPT-6.1-Sol.

This document answers a second request of the same day, also paraphrased: a
fresh, independent look at installation and onboarding with its own
proposals, compared against the first document.

The six points of part B are numbered as the specification numbers them:
(1) account first, (2) memory import, (3) teach the orchestrator, (4) create
it for the user, (5) ask what to do and explain that it starts an agent,
(6) Claude preferred, Codex GPT-6.1-Sol when only Codex is connected.

## 1. The independent proposal in brief

### Part A: build in what the launcher does, with our own means

The launcher gives its user three things: an icon with its own window, a
server that is started for them, and a private install of Bun and Delegatus.
It stops at our Engines step, because it installs no agent CLI
(`Source/Launcher.swift:443,451`), and that step shows no install command
(`src/lib/i18n/en.ts:6533-6534`). My recommendation takes the three things one
by one.

1. **Window and icon: a web app manifest, and one paragraph of docs today.**
   Delegatus serves no manifest: `src/app` holds `icon.svg` and
   `apple-icon.tsx` and no manifest route, and `src/app/layout.tsx` names
   none. With a manifest (name, 192 px and 512 px icons, `start_url`,
   `display`), Chromium browsers install a site served from `127.0.0.1` as an
   app with its own window, and need no service worker for that. Safari 17 on
   macOS 14 adds any site to the Dock, with or without a manifest. (MDN,
   "Making PWAs installable"; Apple Support article 104996.) A Mac user can
   therefore have a Dock icon and an own window today, and the guide can say
   so before anything is built. Nothing is signed, notarized or tested on
   Windows.
2. **A server that is there when the icon is pressed: start at login, opt-in.**
   The website's install prompt starts Delegatus with `nohup … &`
   (`landing/site/copy.js:36`), which ends at the next reboot. A packaged
   install has no login service; the guide documents one only for a checkout
   under systemd (`docs/guide/operations.md:42-48`). One command that writes
   and removes a per-user login service on macOS and Linux closes that gap,
   and the install prompt offers it. This is question V2.
3. **The private install: already ours.** The install prompt installs Bun,
   the agent CLI, the package, starts Delegatus and registers the MCP server
   (`landing/site/copy.js:21-51`, `docs/guide/getting-started.md:105-127`). It
   covers the one thing the launcher leaves out, the agent CLI.
4. **For launcher authors: a short guidance section** in
   `docs/guide/configuration.md`, with no stability promise beyond the
   documented flags. Readiness is the `viewer.server` row of
   `delegatus doctor --json` (`docs/design/onboarding-diagnostics.md:38`).
5. **The community launcher is named in docs** as an unofficial community
   project once it offers a downloadable build. Its code is left where it is.
   No Windows launcher of any origin while native Windows cannot run the
   orchestrator (§4, W4).
6. **A signed first-party Mac app** stays deferred until items 1 and 2 are
   shown to fall short.

### Part B: three numbered steps, then one form

The existing dialog carries all of it. Numbered path: **Engines → Project →
Orchestrator**. After Create: the greeting, one first-task form, the walk.

| Point | What the newcomer meets | Existing carrier | Change |
|---|---|---|---|
| 1 account | Engine cards with sign-in rows; with no CLI, the install command with Copy | `EnginesStep.tsx`, `CopyButton` | The command line in the card (same as the first document) |
| 2 memory | One sentence on the Engines step: agents started here already read your Claude and Codex memory. The import switch sits under "Later, any time" as its own entry, off | The step's note line; the Settings row `MemorySourceRow` | One sentence; one "Later" entry that renders the existing row; the import's host fixed first (§6, slice 1) |
| 3 teach | The Orchestrator step's three lines and schematic; the walk | `OrchestratorStep.tsx:214-228`, `OnboardingWalk.tsx` | None |
| 4 create | One press, with project, engine, model and account chosen | `OrchestratorStep.tsx:195-200` | On a one-engine install the same press moves the roles pipelines need, and the step says so in one line (V4) |
| 5 ask | Greeting, then one decision form "What should I do first?" with three tasks found in the repository; the first is a read-only tour. Each option says what it starts | The seat's greeting (`src/lib/orchestrator/prompt.ts:133,147-151`); the Decisions tab; "Needs you" | One directive for a fresh seat on a first-run install (a new mandate version) (V5) |
| 6 engine | Claude · Opus · high when Claude is connected; Codex only: GPT-6.1-Sol · high and one sentence recommending Claude | `orchestratorRuntime` (`OrchestratorStep.tsx:56-62`) | The advice sentence (same as the first document) |

The measure I would hold the flow to: five minutes after the page first
opens, an agent has answered about the user's own repository, and nothing on
the way asked for a terminal, a git remote or a second engine.

## 2. Where I agree with the first document, and where I differ

### Agreement

The first five rows I reached from the code before reading the first
document. The last three I accept from it, and each says what I held before.

| Topic | Shared position | My evidence |
|---|---|---|
| Adopting the launcher's code | No. Two native stacks and two signing chains for a product whose Windows shape cannot run the orchestrator | `docs/design/windows-support.md:728-743`; the launcher's own `README.md` "Validation status" |
| Install command in the engine card | Yes, with Copy. The command is printed only in the terminal start output, which a user who started from an icon never sees | `bin/agent-binaries.mjs:48-49`, `en.ts:6533-6534` |
| Memory import on a newcomer's install | Defective today: notes outside a seated project are hosted by the Delegatus repository's own project | `src/lib/memory/importWork.ts:430-437`; the committed test `src/lib/memory/importLifecycle.test.ts:68-80` asserts exactly this host choice outside a checkout; `src/lib/memory/curation/run.ts:136-155` hosts passes only on projects with a designated seat |
| Curator on a Claude-only install | Its role defaults to Codex, so its pass cannot start | `src/lib/roles/defaults.ts:379-381` |
| First pipeline on a one-engine install | Refused before any stage starts; the Engines note promises a "next step" that is Project | `src/lib/pipelines/engine.ts:630-661`, `en.ts:6540`, `src/lib/onboarding/steps.ts:15-17` |
| Linking it | Only once a build can be downloaded. Before reading I would have listed it now with its stated limits; the first document's point that nothing can be downloaded changed that | The launcher's README says the ready-made package "is distributed separately" and names no place; its remote has no tags (`git ls-remote --tags`, 2026-11-10) and its tree holds no app bundle or archive |
| Orchestrator row stays out of the role move | Yes; `orchestratorRuntime` already gives Codex GPT-6.1-Sol at high and returns to Claude once it is connected. Before reading I had only noted that two places set the Codex orchestrator's effort differently | `OrchestratorStep.tsx:56-62,85-90` (high), `src/lib/roles/equivalents.ts:81` (medium) |
| One press for Create; soft insistence on an account; Telegram numbered only with a bot connected | Yes to all three (the first document's Q2 a, Q5 a, Q6 a). One press I held before reading; my note moved Telegram to "Later" outright, and the first document's condition is the better rule | `OnboardingDialog.tsx:29-38` ("nothing is gated"), `src/lib/onboarding/steps.ts:1-14` |

### Differences

**D1. The answer to "can we build it in" is the manifest, first.** The first
document recommends a launcher contract now and leaves the manifest "until the
operator asks" (its §4 and §9), with the browser question recorded as "Not
checked" (its §3.8, last row). I looked it up. MDN states that a PWA is
installable when served "from a local development environment using
`localhost` or `127.0.0.1` — with or without a port number", lists the manifest
members Chromium needs, says a service worker is "not a requirement", and says
Safari supports Add to Dock "for any web app with or without a manifest file".
The team gate already lets `/manifest.webmanifest` through
(`src/lib/team/gate.ts:40`). The contract gives a user nothing to press; the
manifest gives every user the launcher's most visible feature for one small
lane. It was not installed from a real browser for this document (§8).

**D2. Guidance for launcher authors, with no promise of stability, and a
different readiness rule.** The first document's contract gives readiness as
"`GET /` answers 200" and commits us to keep the contract stable for third
parties. Two facts speak against the readiness rule.
- Our own launcher treats any status from 200 to 499 on `/api/files` as
  ready (`bin/cli.mjs:901-906,924`).
- With the access key on, the Viewer asks "every connection for it, loopback
  included" (`bin/cli.mjs:947-949`) and answers a page request without the
  key with 403 (`src/proxy.ts:42-53`). The key turns on when the setup guide's
  Phone step has written its flag (`bin/cli.mjs:1183-1188`).

So `GET /` = 200 is false on an install that followed our own guide to its
Phone step. The existing `viewer.server` row of `delegatus doctor --json`
already separates a live Delegatus from a foreign listener and reports a
protected one as degraded (`docs/design/onboarding-diagnostics.md:38`). That
row is the readiness rule I would publish. A stability promise on the stop
path would bind the runtime host, which AGENTS.md classes as the critical
runtime, to an audience the first document itself expects may never read it.

**D3. Memory import leaves the numbered path, and stays off by default.** The
first document puts the switch on the Engines step, on when notes are found
(its Q3 a), held until Create. I would show one sentence there and move the
switch to "Later, any time". Reasons:
- Nothing is lost by waiting. Before any choice, agents get the engines' own
  memory and Delegatus rules together (`docs/guide/memory.md:46-47`,
  `en.ts:120`). The newcomer's notes already reach their first agent.
- The import changes the whole installation: when it finishes, Claude's and
  Codex's own memory is off for every agent Delegatus starts (`en.ts:126`).
- Its work is agent turns on the newcomer's plan, hosted by their only seat,
  one pass at a time; on the store it was designed for a pass took 20 to 40
  minutes (`docs/design/memory-source-switch.md:541-552`). On one account it
  shares the five-hour window with the first task. A newcomer's cost was not
  measured.
- The shipped default for installs that never chose is reserved for the
  operator's answer to a one-week trial
  (`docs/design/memory-source-switch.md:1017-1025`). The commit log names
  slices 1 to 4 and 6 of that design and no slice 7
  (`git log --grep "One memory, slice"` lists four commits). A switch that
  arrives on for every newcomer with notes sets that default by another
  route.
- The first document's count of notes needs a new server read over the
  engines' memory folders on a request; the import design keeps such reads
  off requests (`docs/design/memory-source-switch.md:358-362`). My sentence
  carries no number.

**D4. The role move belongs to Create.** The first document puts "Move them to
{engine}" on the one-engine line of the Engines step for the user to press.
The guide never gates and Continue stays available
(`OnboardingDialog.tsx:29-38,468-470`), so a newcomer who presses Continue
keeps the refusal on their path. I would state the move on the Orchestrator
step in one line ("Codex is not connected, so 10 roles will also run on
Claude. Change") and perform it with Create, through the same `PUT /api/roles`
the table uses, with the table's Undo (`AgentMappingTable.tsx:457-465,
493-499`). The engine set is settled at that moment; on the Engines step a
user who signs in to Claude first and Codex a minute later would have moved
ten rows for nothing.

**D5. The host fix comes before any guide change that starts imports.** The
first document builds the guide's memory row in slice 2 and fixes the import's
host in slice 3. Between the two, every import started from the guide would
curate the seat project's notes and leave the rest waiting with no reason on
screen, as its own §3.6 infers. The fix is a defect repair for today's
Settings switch on any packaged install, and it needs no operator answer.

**D6. The cheaper-Codex link stays; I would not ask its Q4.** The link
answers a tester's finding recorded on board task e6a358dc, whose check
"newcomer cost choice" is still open, and Claude is already the default the
2026-11-10 request prefers (`OrchestratorStep.tsx:262-267`). Removing a
shipped answer to an open acceptance check needs a reason the request does
not give.

**D7. Point 5 needs a first task, and the first document supplies only its
wording.** A new placeholder and one more greeting sentence explain that
sending starts an agent. The newcomer still has to invent the task, and the
only example on screen is "add a delete command to todo.py" (`en.ts:6490`).
§3, N3 gives the form.

## 3. New proposals

**N1. The install prompt is the first-party launcher; give it the two things
it lacks.** It already performs every install step the community launcher
performs and the agent CLI besides. It lacks survival across a reboot and a
window. V2 and the manifest supply both, and the prompt's last step can tell
the user how to add Delegatus to the Dock or install it from the browser's
address bar.

**N2. The manifest also decides the phone.** WebKit's announcement of Web
Push says a web app "added to the Home Screen can request permission to
receive push notifications" from iOS 16.4, and that such an app needs a
manifest whose `display` is `standalone` or `fullscreen`. Our push bell needs
`PushManager` and a secure context (`src/components/PushBell.tsx:27`), and the
phone reaches Delegatus over the tailnet's HTTPS (`bin/tailscale.mjs:370-376`).
I infer that question pushes cannot be turned on from an iPhone today and can
once the manifest exists. Not tested on a device.

**N3. The first conversation: greeting, then one form.**
1. At once, the existing two lines: "Ready in {project}." and the offer.
2. Within about two minutes, one decision form in the Decisions tab, counted
   by "Needs you": "What should I do first?" The orchestrator reads only the
   README, the top-level listing and the open issue titles when a forge is
   connected. Three options and a free-text answer:
   - a read-only tour: how this repository is built and three things worth
     fixing first. It starts one agent at most, writes nothing, and needs no
     pipeline, no git remote and no second engine;
   - two concrete tasks it found (an open issue, a missing test, a TODO), each
     saying that it starts a builder and a reviewer on the user's plan.
3. After the answer, work runs as it does today. The tour's three findings
   arrive as the next form.

The walk's third stop then points at a real item: the first thing that needs
the newcomer is this form. On an empty board no maintenance report follows the
greeting (`src/lib/orchestrator/boardReportRun.ts:132-134`), so the form is the
seat's only second message. On a phone the answer is one tap, where typing a
first task is the hardest thing the screen asks. The operator's standing rule
that every ask goes in a form is kept, and no new control is drawn.

**N4. What to cut.**
- The memory row from the numbered path (D3).
- Telegram from the numbered path when no bot is connected (the first
  document's Q6 a).
- The contract as a promise (D2).
- Any launcher feature that stops a process by port. Both launchers list the
  listeners on 8898 and stop them after a confirmation
  (`Source/Launcher.swift:572-617`, `Windows/Resources/Launch-Delegatus.ps1:452-472`).
  This project stops processes by recorded identity
  (`delegatus stop --all`, `bin/cli.mjs:1160-1171`), and AGENTS.md warns
  against commands that enumerate runtime processes and act on them.
- A Windows launcher, ours or anyone's (W4).

**N5. Native Windows: say it on the first screen.** On `win32` the Engines
step should open with one sentence: the orchestrator needs WSL 2, with the
guide's Platforms link. Today the guide leads to Create on a platform where
our design lists "the MCP server for orchestrator agents" as unsupported
(`docs/design/windows-support.md:742`, `docs/guide/getting-started.md:66-70`).

**N6. Voice changes nothing in the numbered path, and one fact is worth
using.** The Voice step offers its ChatGPT backend once Codex is signed in;
without Codex the row points back at the Engines step
(`src/components/onboarding/VoiceStep.tsx:120,229-232`). OpenAI needs a saved
key (`VoiceStep.tsx:21,209`) and the local backend an install
(`VoiceStep.tsx:222-228`). A newcomer with Codex connected can therefore
dictate the form's free-text answer with no further setup, by my reading; a
Claude-only newcomer cannot. I would add nothing to the guide for this: the
form's free text is the seat composer, whose microphone is already there.

**N7. A probe worth one lane: the second Claude sign-in on macOS.** Agents
start with an explicit `CLAUDE_CONFIG_DIR`, and Claude Code derives its
Keychain entry from that path, the default home included
(`src/lib/accounts/claudeCredentials.ts:33-41`). A Mac user already signed in
to Claude Code therefore signs in again inside the guide; the card explains it
(`en.ts:6494`). Whether the default account could start without the variable
and reuse the existing login is unknown and needs a Mac. If it can, the
largest single step of point 1 disappears for that user. Deferred until
someone can run the probe.

**N8. Two numbers for slice 0.** Seconds from the install command to the
first page, and presses, pastes and sign-ins from the first page to the
greeting, in each of the four sign-in situations. By reading, the shortest
path today for a user whose CLI is already signed in is five presses:
Continue, a project row, Continue, Continue past Telegram, Create.

## 4. Risks and wrong premises the first design missed

**W1. After our Phone step, the launcher reads a healthy Delegatus as a busy
port.** Both launchers call a server healthy only when `GET /` answers 200
with HTML containing "Delegatus" and a script that loads
(`Source/Launcher.swift:112-133`, `Launch-Delegatus.ps1:496-507`). Once phone
access is on, that request answers 403 (D2). The Mac launcher would then wait
90 seconds, stop the server it started and report a failure
(`Launcher.swift:193-200`); on the next start, with a server running, it
reports the port as busy and offers to stop its listeners
(`Launcher.swift:136-139`). The Windows flow reaches the same offer
(`Launch-Delegatus.ps1:748-757`). Inferred from the two code readings; not
run. The first document noted the possibility for a team install only and
then wrote `GET /` = 200 into its contract.

**W2. The launcher's own window probably cannot use the microphone.** The Mac
app's `Info.plist` is written by `Source/build.sh:19-37` and holds no
microphone usage key, and `Launcher.swift` contains no media-capture
permission handler. Apple's documentation of `NSMicrophoneUsageDescription`
says the key "is required if your app uses APIs that access the device's
microphone", on macOS from 10.14. Voice is one of the product's listed
features (`README.md:188`). I infer that dictation and voice conversations
fail in that window; what macOS does without the key was not confirmed, and
the app was not run.

**W3. Default-on memory import pre-empts a reserved decision and spends the
first hour's plan** (D3). The first document's Q3 a states the effect on the
engines' memory and leaves out both points.

**W4. On native Windows the flow's goal cannot be reached.** The first
document weighs Windows under part A only. Part B's last step creates an
orchestrator whose tools come from the MCP server that our own design lists as
unsupported there (N5). How the guide behaves on Windows was exercised by
neither document.

**W5. The move button can be skipped on the default path** (D4), so the
refusal the step exists to prevent stays reachable.

**W6. Slice order ships a known-stuck import** (D5).

**W7. A window without a server.** The manifest alone opens to the browser's
connection error after a reboot. Either V2 is built or the docs say plainly
that Delegatus is started from a terminal first.

**W8. The pin is a starting version.** The launcher installs
`delegatus-cli@1.11.0` (`Source/setup-runtime.sh:91`,
`Launch-Delegatus.ps1:22`). The packaged updater first shipped in v1.10.0
(`git tag --contains dd6e3d32a0`), so such an install can update from the
Update dialog. Whether that update completes from 1.11.0 to the current
release without a terminal is unknown to both documents. Our own history
shows why a pin is tempting: releases 1.13.0 to 1.15.0 stopped macOS installs
from starting (AGENTS.md, the SQLite section).

**W9. The first page a phone meets without the key names the old product.**
The 403 text tells the user to run the command under its previous name
(`src/proxy.ts:48`). Small, and on the first-run path of every phone user.

## 5. Questions for the operator

Each has exactly one recommended answer. How they relate to the first
document's six: **V1 replaces Q1. V3 replaces Q3. V2, V4 and V5 are new;** V4
sharpens its step 1b, which it decided without asking, and V5 sharpens its
step 5. **Q2 and Q6 stand as written,** and I would answer a to both. **Q4 and
Q5 need not be asked:** Q4 for the reason in D6, Q5 because the guide's
"nothing is gated" rule already answers it softly. That leaves seven: V1 to
V5, Q2 and Q6.

**V1. What do we build in from the community launcher?**
- a) Its function, with our own means: say in the guide that Safari adds Delegatus to the Dock today; add a web app manifest so Chrome and Edge install it as its own window with our icon, on the computer and on the phone; add a short section for launcher authors on how to start, probe and stop Delegatus. Name the launcher in docs as an unofficial community project once it offers a downloadable build. **Recommended.**
- b) Publish a launcher contract that we promise to keep stable, link the launcher once it offers a downloadable build, and leave the manifest for later (the first document's answer).
- c) Adopt its Swift, C# and PowerShell code as the official launcher, with signing, notarization and Windows testing on us.
- d) Build a signed macOS app of our own now.
- e) Do nothing.

**V2. Should Delegatus be able to start with the computer?**
- a) Yes, opt-in: one command installs and removes a login service for a packaged install on macOS and Linux, and the website's install prompt offers it. Built after the manifest. **Recommended.**
- b) No: after each reboot the user starts Delegatus from a terminal, and the installed window shows a connection error until then.
- c) Yes, and on for every packaged install without asking.

**V3. When does a first run offer the memory import from Claude and Codex?**
- a) The Engines step says in one sentence that agents started here already read your Claude and Codex memory. The import switch sits under "Later, any time" as its own entry, off, and works once an orchestrator exists. **Recommended.**
- b) On the Engines step right after sign-in, switched on when notes are found, sent when the orchestrator is created (the first document's answer).
- c) On the Engines step right after sign-in, switched off.
- d) Only in Settings, as today.

**V4. On an install with one engine connected, when do the roles that pipelines need move to that engine?**
- a) With "Create the orchestrator": the Orchestrator step says in one line how many roles will also run on the connected engine, the press moves them, and the roles table keeps its Undo. The orchestrator's own row stays on Claude. **Recommended.**
- b) On the Engines step, when the user presses "Move them to {engine}" on the one-engine line (the first document's design).
- c) Never by the guide: the first pipeline is refused and its message names the fix.

**V5. What does the orchestrator do right after its greeting on a first run?**
- a) It reads the README, the top-level listing and the open issue titles, and posts one decision form, "What should I do first?", with three tasks; the first is a read-only tour of the code that needs no pipeline. Each option says what it starts, and a free-text answer stays. **Recommended.**
- b) It waits for a typed request, as today, with the first document's new placeholder and greeting sentence.
- c) The guide's last step gets a text field for the first request and sends it with Create.

## 6. Slices as I would order them

| Slice | Content | Needs before it starts | Output |
|---|---|---|---|
| 0. Measure | The first document's four measurements, plus: (v) on a real Mac, Safari's Add to Dock on today's build, and Chrome's and Edge's install from `127.0.0.1` with a manifest served from a scratch export; (vi) the launcher's readiness request against a Viewer with the access key on; (vii) the two numbers of N8; (viii) `PushManager` in an iPhone tab and in a Home Screen app | Nothing | A verification note with commands, outputs and frames |
| 1. Import host and curator | The first document's slice 3, moved first: the host falls back to a project with a designated seat; the Settings line names a missing orchestrator; the curator starts on the connected engine | Slice 0 (i) and (iv) | One PR with tests that fail on the current code |
| 2. Manifest and docs | The manifest route with the existing icons; the guide's paragraph on Add to Dock and "Install"; the launcher-authors section in the configuration guide | V1; slice 0 (v) | One PR; a real-browser install recorded as evidence |
| 3. Prototype | Numbered variants on the real guide components: Engines with the command line and the memory sentence; Orchestrator with the roles line and the Codex advice; "Later" with the memory entry; the first-task form as the Decisions tab draws it. en and uk, light and dark, 1440, 900 and 390 px | V3, V4, V5, Q2, Q6 | Frames; critic, fix, publish as a decision form |
| 4. Guide and mandate build | The chosen variant; the first-run directive as a new mandate version | Slice 3's choice; slice 1 merged | One PR with dom tests per state and the board driver's frames |
| 5. Start at login | The command, its doctor row, the install prompt's step | V2 a; three review rounds, since it touches launcher and runtime host lifecycle | One PR; a run under the pinned Bun on Linux and on a Mac |

The first buildable slice is slice 0, and slice 1 can start beside it. No UI
is built before the slice 3 prototype has passed its critic and the operator
has chosen.

## 7. Deferred — not currently justified

- **Adopting the launcher's code, and a Windows launcher of any origin.**
  Revisit when native Windows runs the MCP server and the orchestrator.
- **A signed macOS app of our own.** Revisit when the manifest and start at
  login are in use and a named gap remains, such as a menu-bar presence.
- **A launcher contract with a stability promise.** Revisit when a second
  external launcher exists and asks for one.
- **Offering the memory import inside the numbered path.** Revisit after the
  trial of `docs/design/memory-source-switch.md` §6 sets the shipped default.
- **Running the Claude Code or Codex installer from the Viewer.** Same reason
  as the first document: a new trust boundary nobody asked for.
- **Reusing the existing Claude login on macOS** (N7). Waits for a Mac probe.
- **A count of notes on the Engines step.** It needs a new read of the
  engines' memory folders on a request.
- **A text field for the first request in the guide.** The form of V5 asks in
  an existing place.

## 8. What I could not confirm, and where I looked

Earlier answers were searched after my own view was written, so they could
not shape it: three transcript searches scoped to this project (an
installable web app window and Add to Dock; a login service for a packaged
install; first-task suggestions from a fresh orchestrator) and one memory
search across onboarding, first run and launcher. None returned earlier work
on the manifest, on start at login or on a first-task form. The designs that
do bear on this view are the ones cited above: `onboarding.md`,
`orchestrator-first-onboarding.md`, `memory-source-switch.md`,
`onboarding-diagnostics.md`, `self-update-every-install.md` and
`windows-support.md` under `docs/design/`.

| Question | Where I looked | Status |
|---|---|---|
| Does Chrome or Edge offer "Install" for our page on `127.0.0.1:8898` with a manifest, and does Safari's Add to Dock pick our icon | MDN "Making PWAs installable" (https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable), web.dev "Install criteria" (https://web.dev/articles/install-criteria), Apple Support 104996 (https://support.apple.com/en-us/104996) | Documented as possible; never tried in a browser here. Slice 0 (v) |
| Web Push from an iPhone tab against a Home Screen app | WebKit, "Web Push for Web Apps on iOS and iPadOS" (https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/); `PushBell.tsx:27` | The post names Home Screen web apps and does not say a tab is refused. Inferred. Slice 0 (viii) |
| W1 and W2 on a running launcher | Its sources, as cited; for W2 also Apple's page for `NSMicrophoneUsageDescription` (https://developer.apple.com/documentation/bundleresources/information-property-list/nsmicrophoneusagedescription), which states the requirement and is silent on what happens without the key | Inferred from code; the fence forbids running it |
| The import's behaviour end to end on a newcomer's install | `importWork.ts`, `curation/run.ts`, `curation/admission.ts`, the committed test | The host choice is asserted by the test; the stuck import is inferred. Slice 0 (i) |
| What a newcomer's import costs in agent turns | `docs/design/memory-source-switch.md:541-552` | Known for the store it was designed on; unknown for a small one |
| Whether the one-week memory trial has run and what it decided | The design and the history of `src/lib/memory/source.ts` | No slice 7 in the history; live state was left unread |
| How the guide and Create behave on native Windows | Our docs only | Not exercised |
| Whether the orchestrator recovers by itself from the one-engine refusal | `src/lib/accounts/engineConnection.ts:70-79` gives it the fix in the message; the mandate has no rule for it | Unknown |
| Launchd behaviour for a per-user login service under the pinned Bun | Nothing in this repository | Unknown; slice 5 runs it |

## 9. Check against the requirement

| Point in the request | Where this view answers it |
|---|---|
| Can the launcher be built in, and how | §1 part A, D1, D2, N1, V1, V2 |
| Convenient installation | The manifest, start at login, the install prompt as the first-party path (N1), the command in the card |
| Account first | §1 part B row 1, N5, N7 |
| Memory import from that account | D3, D5, V3, slice 1 |
| Teach that work starts with the orchestrator | §1 part B row 3, N3 |
| Possibly create it for the user | The first document's Q2, V4 |
| Ask what to do and explain that it starts an agent | N3, V5 |
| Claude preferred; Codex only runs on GPT-6.1-Sol with advice | §1 part B row 6, D6 |
| Second request: independent proposals, compared | §1, §2, §3, §4, §5 |

## 10. Decisions

Recorded 2026-11-10. The operator answered the seven questions of §5 in one
form and chose the recommended option of each.

| Question | Answer | What it means |
|---|---|---|
| V1. What is built in from the community launcher | a | The launcher's function with our own means: a web app manifest, so Chrome and Edge install Delegatus as its own window with our icon on the computer and on the phone; a guide paragraph saying that Safari adds Delegatus to the Dock today; a short section for launcher authors on how to start, probe and stop Delegatus. The launcher's code is not adopted. The launcher is named in docs as an unofficial community project only once it offers a downloadable build, which it does not today, so it is not named yet. |
| V2. Start with the computer | a | Opt-in: one command installs and removes a login service for a packaged install on macOS and Linux. |
| V3. Memory import in a first run | a | One sentence about memory on the Engines step. The import switch sits under "Later, any time", off, and works once an orchestrator exists. |
| V4. Roles that pipelines need on a one-engine install | a | They move with "Create the orchestrator", the step says so in one line, and the roles table keeps its Undo. |
| V5. After the greeting | a | One decision form with three first tasks; the first is a read-only tour. |
| Q2. The first orchestrator | a | One press, with project, engine, model and account already chosen. |
| Q6. The Telegram reports step | a | It stands before the orchestrator only when a bot is already connected; otherwise it sits under "Later, any time". |

Delivered with this section: the manifest, the guide paragraph and the
launcher-authors section (slice 2 of §6). Start at login, any change to the
first-run guide's steps, the memory import, a signed app, a Windows launcher
and a service worker stay out of that slice and are built by later slices.
