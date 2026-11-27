# Onboarding v2: a welcome, accounts with install and sign-in, roles from the accounts, the ChatGPT plan

Status: design decided by the operator on 2026-11-25 (section 0.1), with a
build plan in slices (section 12). Slices 1 and 2 (sections 12.2 and 12.3)
are built; nothing else here is in the product.

In this tree since 2026-11-26: this document and
[the subscription study](onboarding-v2-subscription.md). The prototype
(`docs/design/onboarding-v2/`) and its `describe` block in the
conversation-window driver stayed on the design lane's branch and were not
merged, so sections 12.8 and 13 describe files this tree does not hold. Since
the plan was written, PR #4473 has merged and PR #4416 has landed on `main`
through #4504; the table in section 12.1 is the reading of 2026-11-25.

Written 2026-11-25 against `main` at `8bb58bd7`; every `file:line` below is
from that commit unless a revision stands beside it. The audit ran the
production build of `32f1df64` (the installed release; the three files that
differ from `8bb58bd7` belong to the Codex host and none to onboarding or the
interface) in a private home and state directory. The prototype is
`docs/design/onboarding-v2/prototype.fixture.tsx`, rendered by one `describe`
block of the conversation-window driver.

Sections 6, 8, 9 and 12 were revised after the decision, the same day. They
read the same product tree, PR #4416 (Sign in with ChatGPT, lane c71f4a65) at
`2baf3151e4d6`, PR #4473 (agent mapping and Antigravity sign-in, lane
97ed7f10) at `3bfba1c2bc62`, and `main` at `e9c4437d81`. The feature routes
come from [the subscription study](onboarding-v2-subscription.md), which
holds the quotes from OpenAI's pages.

## 0. Originating requirement

Source: the operator's voice message to the Delegatus orchestrator seat,
2026-11-25, pinned as the task of this lane. The verbatim message stays
private; this is a neutral English paraphrase:

> Redesign the onboarding, with Claude on the Fable model doing the design.
> First audit the current onboarding: what it launches and what it fails to
> launch. Then the new flow: a welcome first. Then check which accounts exist
> and ask whether to add one. Installing Claude Code, Codex and Antigravity
> happens from the interface, with a button, and signing in happens there too.
> When the accounts are settled, show the default roles, chosen with those
> accounts in mind, and offer to change them. Then, when Codex is signed in
> with a ChatGPT subscription, offer the sign-in through ChatGPT so that API
> access carries over, and offer to switch on every API-backed feature at
> once, since the Pro subscriptions include API usage. Design and prototype
> only; build nothing into the product.

Operator rules that apply to every screen: reuse an existing control before
adding chrome; a status is a dot with a short popover and never a wide text
pill; no liquid glass.

### 0.1 The decision of 2026-11-25

Source: the operator's answer to the prototype review of this design, given
the same day, with eight variants and six questions in front of them.

| Screen | Chosen |
|---|---|
| Welcome | **2**, welcome with what was found |
| Accounts | **1**, rows (this settles Q7) |
| Roles | **1**, summary by group |
| ChatGPT plan | **2**, the feature list with a switch per feature |

Q1 to Q6 were all answered as recommended (section 9). One comment came with
the answer. The verbatim comment stays private; a neutral paraphrase:

> Something is off on the ChatGPT plan step. As I understand it, the sign-in
> on the subscription gives an API key, and we could use that key for
> Decisions as well. The step does not take that into account. So all the
> features, or nearly all of them, should be able to run on this
> subscription.

Section 6 answers the comment feature by feature. In one sentence: the
sign-in gives no key, a Pro or Business plan pays for all six features once
its API credits are claimed and one key is pasted, and a Plus plan pays for
two.

## 1. Short answer

- **The current guide starts in the middle.** It opens by itself on an Engines
  step with no welcome. It detects Claude Code, Codex and Copilot, shows a
  command to copy for the first two, and runs nothing itself. Sign-in works for
  Claude and Codex and sits two presses deep inside the accounts panel. Roles
  are a "later" step that shows shipped constants. Antigravity and the ChatGPT
  plan are absent. On a phone the first-run telemetry notice covers the guide's
  main button. Section 2 has the evidence.
- **The new flow** is Welcome → Accounts → Roles → ChatGPT plan → Project →
  Orchestrator, with the last two unchanged. The plan step is numbered only
  when a Codex account is signed in with a ChatGPT subscription.
- **Install by button is feasible and fast.** The three vendors' installers
  ran in an empty scratch home in 7 to 8 seconds each, with no administrator
  rights, and print named steps without a percentage. Section 4 says what the
  button runs and what guards it.
- **One premise of the requirement does not hold as worded.** The ChatGPT
  sign-in hands no API key to a third-party app, and OpenAI documents no route
  by which it could. Pro and Business plans do include monthly API credits, and
  those reach an app through a key the subscriber creates. Section 6.
- **Which features the subscription pays for.** Voice Delegatus and recorded
  dictation run on the Codex account's ChatGPT sign-in today, on any paid
  tier, with no key. Read aloud, Asks you, Memory in chats and Learned rules
  need an OpenAI API key. On Pro and Business the plan's API credits pay for
  that key's usage, so the subscription covers all six after one paste. On
  Plus those four are billed to an API balance. Section 6.2.
- **Chosen variants (2026-11-25):** Welcome 2, Accounts 1, Roles 1, ChatGPT
  plan 2 (section 8).
- **Build order.** Six slices; five of them wait for nothing in PR #4416, and
  only the last one adds that lane's sign-in button (section 12).

## 2. Audit of the current onboarding

### 2.1 Method

A scratch export of the repository with the installed release's production
build was served by `next start` on a free loopback port, with `HOME`,
`LLV_STATE_DIR`, the Claude and Codex homes, `TMPDIR` and the tmux socket
directory all under the stage's scratch, the account controller and the reaper
off, and a stub in place of `tailscale`. A browser walked the guide in three
scenarios, in Ukrainian and English, at 1440×900 and 390×844:

| Scenario | Machine |
|---|---|
| `s0-nothing` | no agent program on `PATH`, no credentials |
| `s1-signed-out` | the real `claude` and `codex` programs, no credentials |
| `s2-ready` | both programs present with credential files, Tailscale answering, one git project |

The first context of every scenario had no storage at all, so its first frame
is a true first visit. Frames and the per-frame record (text, buttons, sizes,
writes, page errors) are in `$LLV_EVIDENCE_DIR/audit/`; names below are
relative to it. The phone walks were repeated with the telemetry notice
dismissed (`audit/phone/`), because the notice blocks the first walk (A9).

### 2.2 What launches and what does not

| Capability | Today | Evidence |
|---|---|---|
| Opening by itself on a first visit | yes, on Engines, in the browser's language | `s0-nothing-1440-uk-00-first-visit.png`; `src/components/onboarding/OnboardingDialog.tsx:126` |
| A welcome | no | `src/lib/onboarding/steps.ts:16` lists `engines, project, telegram, orchestrator` |
| Detecting Claude Code, Codex, Copilot | yes | `OnboardingDialog.tsx:92`; `src/components/onboarding/EnginesStep.tsx:187` |
| Detecting Antigravity | no | `src/app/api/accounts/cli/route.ts:11` answers `claude` and `codex` only |
| Installing an agent program | no: a command to copy for Claude and Codex, a sentence for Copilot | `EnginesStep.tsx:69`; `src/lib/onboarding/agentInstallCommands.ts:11` |
| Signing in to Claude | yes, after opening the account row | `s1-signed-out-1440-uk-13-claude-sign-in-pressed.png` |
| Signing in to Codex | yes, same path, with a device code | `s1-signed-out-1440-en-13-codex-sign-in-pressed.png` |
| Signing in to Antigravity | no | lane 97ed7f10 adds it |
| Finding existing accounts | yes | `s2-ready-1440-uk-10-engines.png` |
| Adding a second account | yes, from the embedded accounts panel | `src/components/AccountsPanel.tsx:1562` |
| Roles chosen from the accounts | no: a "later" step with shipped constants and a one-press move for a single engine | `steps.ts:18`; `src/components/onboarding/AgentMappingTable.tsx:147` |
| The ChatGPT plan, API-backed features | no step | Voice lists dictation providers only (`s2-ready-1440-uk-36-voice.png`) |
| Project, orchestrator, Telegram, memory, phone, check, relay | yes | `s2-ready-1440-uk-30-project.png` … `-38-relay.png` |

### 2.3 Findings

**A1. No welcome.** A first visit lands on "Which engines can run here": a
paragraph about command-line tools, then cards. Nothing says what Delegatus is
or what the next three minutes hold (`s0-nothing-1440-uk-00-first-visit.png`).

**A2. Install is a copy-and-paste errand.** With nothing installed, the Claude
and Codex cards show a `curl … | bash` line with a copy button. Copilot shows a
sentence and no command. One "Check again" button sits on the first missing
card (`EnginesStep.tsx:204`); pressed with nothing installed it changes nothing
on screen and says nothing (`s0-nothing-1440-uk-11-engines-after-check-again.png`).

**A3. Sign-in works and is buried.** A signed-out engine shows the whole
accounts panel inside its card. The newcomer opens the row "Main", then presses
"Sign in". Claude then shows a link to claude.ai and a field for the code;
Codex shows a link and a device code. Both operations start correctly in an
isolated home. The same card also carries a usage header ("% left · reset"), a
"Remove" action, "Add compatible provider" and a paragraph about a third-party
gateway, none of which a first run needs
(`s1-signed-out-1440-en-13-codex-sign-in-pressed.png`). "Add an account" is
disabled while a sign-in is pending (`AccountsPanel.tsx:1562`), which is
correct and unexplained.

**A4. Antigravity is half present.** The Engines step has no Antigravity card
and `/api/accounts/cli` never names it, yet the agent mapping offers an
Antigravity segment on every row. `OnboardingDialog.tsx:273` computes
`connected: cli.antigravity !== "missing"` from a value no route supplies, so
on `main` Antigravity reads as connected on a machine that has no `agy`. Lane
97ed7f10 adds the card, the probe and the sign-in block.

**A5. Nothing is gated, and the orchestrator step then says something false.**
With no engine installed, Continue leads to Project and on to Orchestrator,
which reads "Runs on Claude · Opus 5.5 · account Main"
(`s0-nothing-1440-uk-21-continue-to-orchestrator.png`;
`src/components/onboarding/OrchestratorStep.tsx:65` falls back to Claude when
nothing is connected). The step's only stated blocker is the missing project.

**A6. Roles ignore the accounts.** "Agents" is a later step. It shows the
shipped mapping whatever is signed in, with a warning on each row whose engine
is missing (`s0-nothing-1440-uk-33-agents.png`). With exactly one of Claude or
Codex it offers one press to move the other engine's rows
(`AgentMappingTable.tsx:147`); Antigravity never takes part. At the guide's
width the three labelled engine segments overflow into the model column and
long role names are cut with an ellipsis
(`s2-ready-1440-en-33-agents.png`; `AgentMappingTable.tsx:45`, `:241`, `:342`).
Lane 97ed7f10 replaces the segments with icons.

**A7. No ChatGPT step.** The only trace is one option in the Voice step
("ChatGPT Voice, through your Codex sign-in"). Keys and the features they
serve live in Settings.

**A8. Dismissal holds.** Escape, ✕ and "Close, finish later" close the guide;
it stays closed after a reload and the empty board keeps a link back to it
(`s2-ready-1440-uk-50-after-escape.png`, `-51-after-reload.png`).

**A9. On a phone the telemetry notice covers the guide's main button.** The
first-run notice is fixed to the bottom at the toast layer
(`src/components/telemetry/TelemetrySettings.tsx:39`; `src/components/layers.ts:66`,
above the guide's modal layer). At 390 px it covers the footer; the walk's
press on Continue was refused because the notice intercepts it
(`s0-nothing-390-uk-10-engines.png`, `s2-ready-390-uk-10-engines.png`). At 1440
it overlaps the footer and hides "Back". After "Got it" the phone guide works:
a full-screen sheet, the step list behind the header, 44 px targets
(`phone/s2-ready-390-uk-10a-engines-notice-dismissed.png`).

**A10. The later steps behave as designed.** Memory asks for an orchestrator
first, Telegram for a project, Check for an engine, Phone for Tailscale; Relay
offers the service. None of them is part of this redesign.

Defects A5 and A9 are independent of the redesign and deserve their own issues.

## 3. The flow

```
Welcome ─► 1 Accounts ─► 2 Roles ─► 3 ChatGPT plan* ─► 4 Project ─► 5 Orchestrator
                                     (* numbered only with a Codex account on a ChatGPT subscription)
Later, any time: [ChatGPT plan*] · Memory · Telegram · Phone · Voice · Check · Relay service
```

The count of numbered steps follows the accounts, and it is settled on the
Accounts step: four steps while no Codex account is signed in on a ChatGPT
subscription, with the plan under "Later, any time", and five from the moment
one signs in. Roles and every step after it show the count Accounts ended
with, so the total never changes between two steps.

The guide keeps its shell: the 920×640 dialog with the 200 px rail on a
desktop, the full-screen sheet with the step list behind the header on a
phone, one filled button per screen, and the rule that nothing is gated. A
state whose next act happens outside the page holds no filled button: an
install that is running, a sign-in being finished in another browser tab, and
a Windows computer whose commands are run by hand.

The words "this computer" are true only in a browser on the computer that
runs Delegatus. In a browser on another device the same sentences say "the
computer running Delegatus": the welcome's list heading, the first line of
what follows, and Antigravity's terminal instruction. A phone is always
another device. The signal is the one the plan step's "browser on another
device" state reads (section 6.3).
"Agents" leaves the later list because Roles is now a numbered step; the same
table stays in the menu under "Agent mapping". Telegram keeps its place before
Orchestrator when a bot is connected.

### 3.1 Welcome

The cover of the guide, shown on the first open only. It names the product in
one sentence and leads into the accounts.

| State | What it shows | Main button |
|---|---|---|
| Accounts found | each agent program as the Accounts step heads its row: the name, and under it the status dot leading the state line; "Want to add another account?" | Continue with these → Roles; "Add an account" → Accounts |
| Nothing found | the same list, all "Not installed"; "Delegatus can install one for you, into your home folder and without administrator rights." | Choose what to install → Accounts |

The list's heading holds in both states: "Agent programs on this computer"
(«Програми-агенти на цьому комп’ютері»), and in a browser on another device
"Agent programs on the computer running Delegatus". It claims nothing was
found when every row says "Not installed".

The check is the existing presence and account read; it needs no new API.
"Continue with these" carries the accounts found into Roles as they are: a
program that is installed and signed out stays signed out, its line on the
welcome says so, and "Add an account" is the way to it.

### 3.2 Accounts

One row per agent program: Claude Code, Codex, Antigravity, and Copilot as it
is today. Each row holds the mark, the name, one state line that its status
dot leads, and at most one action. The dot's popover is two short lines at
most and opens beside the row's name, where it covers no words: the product's
`StatusDot` already places a popover that way for a Settings row, given the
row and its label. Copilot has no mark in `EngineMark`, whose fallback is a
neutral dot; beside the status dot that reads as two statuses, so the Copilot
row leaves the mark's place empty until the product draws one. In the cards
variant a card's left edge is the engine's identity colour, and status colours
stay out of it. Copilot's tint in the build is a green one step from the
"Connected" green, so its card takes the neutral border colour until the
product gives it a mark and a tint.

A status dot stands in one place on every screen of the guide: before its
words, on their line. That holds for a program's state line, for the same
line on the welcome, for each account under a program, and for the credits
heading of the plan step. A state line keeps one line; on a phone an action
with no room beside it goes under the row's head. The Ukrainian retry button
reads «Повторити», which fits beside «Не вдалося встановити» at 390 px.

While any row offers Install, the step's first paragraph ends with what every
Install shares: it runs under your user, without administrator rights.

| State of a program | State line | Dot | Action | Under the row |
|---|---|---|---|---|
| Not installed | Not installed | grey; popover says where it was looked for | Install, with one line beside it naming the source and the folder before the press: "Installs from claude.ai into ~/.local/bin" | — |
| Installing | current step and seconds | amber | Cancel | three-step progress; Details with the installer's address, the folder and the log tail |
| Install failed | Install failed (amber text, the dot's tone) | amber; popover holds the cause | Try again | the reason, then "Or run this command yourself, then press Check again beside this step's heading", the command to copy and Details on its line |
| Installed, signed out | Installed, signed out | amber; popover holds version and path | Sign in for Claude Code and Codex; none for Antigravity and Copilot | Antigravity: its terminal sign-in (section 4.4). Copilot: one sentence, "Run copilot in a terminal on this computer and sign in there, then press Check again beside this step's heading" |
| Signing in | Signing in | amber | — | the engine's own sign-in block (section 4.4) |
| Signed in, one account | Connected · plan | green; popover holds the version and the limit left | "Add an account" as a text action; on a phone it stands under the row, where the list of several accounts ends too | — |
| Several accounts | "3 accounts · 1 needs sign-in" | green, or amber when one waits, and then its popover names the account that waits | — | one row per account: its dot, its name and plan, and, whenever the dot is not green, the reason in words on a line under the name ("18% of the session limit left"; "needs sign-in", with "Sign in" at the row's end); "Add an account" |
| Unsupported here | "Needs WSL 2 on Windows" | grey | — | one sentence saying what to do |

The first program that needs an action holds the filled button; while an
install runs, no other row holds one. Once one agent account is signed in, the
footer's Continue becomes the filled button; until then the footer reads
"Continue without an agent" as a bordered button, so the guide stays ungated
and stops implying that nothing is missing.

An account's dot turns amber under 30% of its session limit. The header line
counts only the accounts that wait for a sign-in, so an amber account that is
signed in says what its colour means in its own words. They take a line under
the name, which leaves the popover its place beside the name in a 300 px card
too. No dot differs from its neighbour by colour alone.

A state's words and its dot take one tone. The product's dot has three (green,
amber, grey), so a failed install is amber in both; red is kept for text that
stands without a dot. The popover of a dot that is not green opens on the
cause and on when it clears, in two short lines at most: "18% of the session
limit left. Resets at 14:00." It never opens on a sentence that is true of a
green dot too ("Signed in.").

A step shows one "Check again", as the guide does today, and it looks for all
four programs. So it belongs to no program's row: it stands at the end of the
heading's line, on the first screen at both widths, while any program is not
installed and while Copilot is installed and signed out. Every row that waits
for a command run by hand (a failed install, Copilot not installed or signed
out, every row on Windows) ends its sentence with where that button is:
"then press Check again beside this step's heading". Today's guide puts the
button on the first missing card, where it reads as that card's own.

### 3.3 Roles

Section 5.

### 3.4 ChatGPT plan

Section 6.

### 3.5 Project and Orchestrator

Unchanged, except that the orchestrator step must name the missing engine when
none is signed in (A5) and no longer moves rows of the mapping, because the
Roles step has already written them.

## 4. Install and sign-in: what each button runs

### 4.1 Why this is now in scope

`docs/design/install-and-onboarding.md` §9 deferred running a vendor installer
from the Viewer as "a new trust boundary nobody has asked for". The
requirement of 2026-11-25 asks for it. The boundary is real, so the design
keeps it narrow.

### 4.2 Measured on 2026-11-25

Each vendor's shell installer was downloaded to a file and run with an empty
scratch directory as `HOME`, on Linux x64, without administrator rights:

| Program | Time | Result | Size | Output |
|---|---|---|---|---|
| Claude Code | 7.9 s | `~/.local/bin/claude` → `~/.local/share/claude/versions/2.1.332` | 387 MB with caches | 22 lines, named steps, a warning when `~/.local/bin` is off `PATH` |
| Codex | 8.1 s | `~/.local/bin/codex` → `~/.codex/packages/standalone/current/bin/codex`, version 0.172.0 | 504 MB | 10 lines, named steps; adds a `PATH` line to `~/.bashrc` |
| Antigravity | 6.9 s | `~/.local/bin/agy`, version 1.5.17 | 278 MB | 17 lines, named steps, its own checksum check |

None of the three prints a percentage. Claude Code's script refuses to run
under `sudo`; the other two never ask for it. Each script names macOS and
Linux, x64 and arm64, glibc and musl. The six vendor addresses (a shell and a
PowerShell installer each) answered 200.

The package route also works for two of them: `bun add --global
--ignore-scripts @anthropic-ai/claude-code` (3.9 s) and `@openai/codex`
(2.2 s) both leave a working program under `~/.bun/bin`. Antigravity has no
official package; the registry names `agy` and `antigravity-cli` belong to
unrelated third parties and must never be installed.

One fact matters for Codex: the vendor script installs whatever is newest, and
on the day of the probe that was 0.172.0 while the newest protocol snapshot
reviewed in this repository is 0.170.0 (`src/lib/accounts/protocol/`).

### 4.3 The Install button

What runs, per program:

| Program | Linux and macOS | Why |
|---|---|---|
| Claude Code | the vendor's `install.sh`, downloaded to a file and run with `bash` | the vendor's supported path; installs under the user's home |
| Antigravity | the vendor's `install.sh`, same handling | the only official path |
| Codex | the package, through the existing Codex updater's prepare step (`src/lib/codexUpdate/`, `docs/design/codex-cli-updates.md`), pinned to the newest reviewed version | the updater already installs with scripts disabled and runs the compatibility gate; the result is a version this product has been read against, and no shell profile is edited |
| Copilot | nothing; the row keeps its instruction | outside the requirement; needs Node and npm |

The job, the same for all three:

1. `POST` starts one install per program and answers an operation id; the
   interface polls it, the way the Claude sign-in operation already works
   (`/api/accounts/claude/login/[operationId]`). A second press joins the
   running job.
2. The address comes from a table compiled into the product. No request can
   supply an address, a flag or a directory.
3. The script is downloaded over HTTPS to a file in the job's own directory,
   with a size limit, and that file is what runs. Its path and SHA-256 are
   recorded, so what ran can be read afterwards. Nothing is piped into a shell.
4. It runs as the user the Viewer runs as, with standard input closed, in its
   own process group, for at most five minutes. It never runs with elevated
   rights; a script that asks for a password fails at once on the closed input.
5. Cancel stops the process group the job started, by the identifier it
   recorded.
6. On exit 0 the job looks the program up again through
   `agentBinaryCandidates` (`bin/agent-binaries.mjs:6`), which already searches
   `~/.local/bin` and `~/.bun/bin`, and runs `<program> --version`. A program
   that installed and cannot be found is a failure with its own sentence.
7. Before starting, the job checks free space in the home file system (1 GB).
8. Only the owner of the install may start it. A team member sees the row's
   state and no Install button.
9. The Viewer in a container cannot install onto the host. There the row
   shows the command to run on the host and points at the step's "Check again".

Before the press, the row says what the button will do, in one line beside
the button (under the row's head on a phone): the source and the folder
("Installs from claude.ai into ~/.local/bin"; for Codex, "Installs
@openai/codex from npm into Delegatus's folder"). The sentence about the user
and the rights stands once, in the step's first paragraph. Details repeats
both in full once the install runs.

Progress on the row: three named steps (Download the installer, Install,
Check the version), the current one in words, and elapsed seconds. Within a
step the bar is indeterminate, because the installers report no percentage.
"Details" unfolds the installer's address, the target folder and the last
lines of the installer's own output. The `curl … | bash` line appears only as
the manual path of a failed or copy-only row, where the person runs it. It is
drawn by the guide's existing command control, which breaks a narrow line only
between the segments `src/lib/onboarding/agentInstallCommands.ts:11` lists
(after the flags, after each slash) and never inside a word. The build adds
Antigravity's line and the three PowerShell lines to that table, each with its
segments.

Failures, each with a sentence in the row, "Try again", the command to copy
and Details:

| Code | Sentence |
|---|---|
| `download_failed` | No connection to the vendor's site. Check the network, or run the command yourself. |
| `installer_failed` | The installer stopped with exit code N. Nothing was changed. / What it left is in Details. |
| `timeout` | The install took longer than five minutes and was stopped. |
| `no_space` | Less than 1 GB is free in your home folder. |
| `not_found_after_install` | The installer finished and the program is not where it should be. The folder is in Details. |
| `unsupported_platform` | This program has no build for this system. |

### 4.4 Sign-in

Each engine keeps the sign-in it has; the redesign moves the start of it onto
the row.

- **Claude Code.** "Sign in" starts the existing operation (`claude auth login
  --claudeai`), opens claude.ai in a tab and shows one field for the code that
  page displays. Works from another device, because the code is pasted.
- **Codex.** "Sign in" starts the existing ChatGPT device-code flow through
  `codex app-server`: a code to enter on the page that opens. Works from
  another device.
- **Antigravity.** Lane 97ed7f10's path, embedded unchanged: `agy` has no
  sign-in command, so the row shows the command `agy` with a copy button, one
  sentence (run it in a terminal on this computer, choose Google sign-in,
  finish in the browser) and "Check sign-in", which asks `agy` through its
  probe. This needs a terminal on the host. In a browser on another device,
  and so on every phone, the sentence names that computer: "Run agy in a
  terminal on the computer running Delegatus, choose Google sign-in and
  finish in the browser there. Then check here."
- **Copilot.** The guide starts no sign-in for it (Q5). A signed-out Copilot
  row holds one sentence and no button: run `copilot` in a terminal on this
  computer (in a browser on another device, "on the computer running
  Delegatus"), sign in there, then press "Check again" beside the step's
  heading. No press on a Copilot row opens another program's sign-in.
- **Another account.** "Add an account" under a signed-in program starts the
  same sign-in for a new account. It is disabled while a sign-in is pending and
  its dot's popover says why.

## 5. Roles: defaults from the accounts

The step shows who does what, already adjusted to the accounts that are signed
in, and writes the adjustment when the person presses Continue.

**The rule.** For every row of the agent mapping:

1. Its shipped engine is signed in: the row keeps its shipped runtime.
2. Otherwise it moves to the first signed-in engine it may run on, in the
   order Claude, Codex, Antigravity, with the model and effort that
   `equivalentConfig` (`src/lib/roles/equivalents.ts:136`) already defines for
   that pair.
3. A row locked to an engine that is missing stays where it is and says what
   it needs. The visual critic is locked to Claude
   (`src/lib/roles/locks.ts`); the orchestrator runs on Claude or Codex only.

What that gives:

| Signed in | Result |
|---|---|
| Claude and Codex (with or without Antigravity) | every row on its shipped runtime |
| Claude only | the 10 Codex rows move to their Claude equivalents |
| Codex only | 8 Claude rows move to Codex; the visual critic stays on Claude and reads "needs Claude" |
| Antigravity only | 17 rows move to Antigravity; the visual critic and the orchestrator stay and say what they need |
| Nothing | the shipped table, with one sentence saying nothing is signed in |

Several accounts of one engine do not change the mapping: which account a role
uses stays with the existing account rotation.

**Changing a role.** Each row has the engine segments (icons, as lane 97ed7f10
draws them), a model select and an effort select, the controls of the existing
table. An engine with no signed-in account stays selectable and sits back at
lower contrast; a row that picks it reads "needs Codex". A changed row reads
"changed · Reset". A row the rule moved reads "moved from Codex". A model has
one name on this step: a group's summary line uses the label its select shows
("GPT-6.1-Sol", "Claude Sonnet 5.5"), never the short form. Continue writes
the moved and the changed rows through the existing `PUT /api/roles`, and the table that opens later from the menu shows
the existing receipt line with Undo.

**On a phone.** The product draws every field on a touch screen at 16 px
(`src/app/globals.css:67`, against the zoom iOS applies to a smaller focused
field), and a control under a finger is 44 px tall. Nineteen rows drawn with
their selects open leave four or five roles to a screen and let the controls
outweigh the 13 px names. So on a phone a row is two lines in the type of the
page, the role's name and its runtime ("GPT-6.1-Sol · high", with "moved from
Codex", "changed" or "needs Claude" beside it), and one row at a time opens
for its three controls. An open row's selects carry regular weight, and
"Reset" stands beside them. The same row serves both variants: under an open
group in variant 1, and as the whole table in variant 2, where ten roles fit
the first screen of a 390×844 phone. The one-time code field of Claude's
sign-in keeps the same 16 px for the same reason.

## 6. The ChatGPT plan step

Decided 2026-11-25: variant 2, the six features as rows with a switch each.
This section is the step as it is to be built. The quotes behind every
statement about OpenAI are in
[the subscription study](onboarding-v2-subscription.md).

### 6.1 Four routes that the requirement treats as one

| Route | What it needs | What it serves | Who pays |
|---|---|---|---|
| The Codex account's own ChatGPT sign-in | a Codex account signed in with ChatGPT | Codex agents; a whole Voice Delegatus call on the `codex` backend; recorded dictation on the `chatgpt` backend | the subscription, on every paid tier |
| Sign in with ChatGPT (lane c71f4a65, PR #4416) | a browser on the computer that runs Delegatus; Delegatus's own grant | the text delegation turns of a call the owner starts on the API voice backend (`/v1/responses` only) | the subscription; on Plus it shares the five-hour limit with the person's other ChatGPT apps |
| A key of an API project linked to the plan's API credits | Pro or Business, at least seven days old; the subscriber claims the credits and creates the key | read aloud, Asks you, Memory in chats, Learned rules, live dictation, the audio of the API voice backend | the plan's monthly credits (Pro: 100, 200 or 500 dollars by tier) until they are spent, then the organization's own billing |
| Any other OpenAI API key | a key pasted by the person | the same six uses | the person's API balance |

**The sign-in hands over no key.** OpenAI's help page for the plan sign-in
says it "does not share an OpenAI API key", and the credential it issues is
for "eligible Responses API requests". Decisions, transcription, Realtime and
speech are outside that route, so the three classifiers and the audio
features cannot ride on the sign-in. The credits are the other half of the
operator's reading and it holds: OpenAI's credits guide lists Decisions and
Realtime among the usage they cover, through "one of its project API keys".
The key is created by the subscriber. No documented route lets an app claim
the credits or receive a key.

### 6.2 The six features and their routes

The list is `SERVICE_FEATURES` (`src/lib/openaiServices/policy.ts:15`). The
step names each feature as Settings → Keys names it
(`featureName`, `src/components/keys/OpenAiServices.tsx:45–56`), so a row
found here is found there under the same words.

| Feature | Route the step offers | On the subscription | Why it stops there |
|---|---|---|---|
| **Voice Delegatus** | ChatGPT through Codex, the whole call (`codex` backend) | yes, on every paid tier, with no key | — |
| **Dictation** | ChatGPT through Codex, recorded clips (`chatgpt` backend) | yes for a recording; live text needs a key | live dictation mints a Realtime credential (`src/app/api/transcribe/token/route.ts:120–134`), which only a key can do |
| **Read aloud** | OpenAI API key | Pro and Business: yes, through the plan's API credits. Plus: no | the plan route carries no audio output |
| **Asks you** | OpenAI API key | the same | the classifier calls `/v1/decisions`; the plan credential cannot |
| **Memory in chats** | OpenAI API key | the same | the same call, inside a 1.5 s budget per message |
| **Learned rules** | OpenAI API key | the same | the same call; local selection stays as the fallback |

The two plan rows rest on two different checks, and a row is available only
when its own check passes. Voice needs a managed Codex account with ChatGPT
credentials (`codexVoiceAvailable`, `policy.ts:63`). Dictation needs the
Viewer to read the local Codex sign-in file (`policy.ts:84`), which a
managed account in the list does not prove. Recorded dictation through Codex
also uses a ChatGPT endpoint that OpenAI has not published as an
integration. It is the backend Delegatus already offers as an opt-in, the
step describes it as that, and its row is the first to change if OpenAI
closes the endpoint.

Counted against the operator's "all or nearly all":

- **Pro and Business: six of six.** Two run on the Codex sign-in with nothing
  to paste. Four run on one key from the project the credits are linked to.
  The one manual act is claiming the credits and pasting that key, once.
- **Plus: two of six.** Plus carries no API credits. The other four need a
  key billed to an API balance, or the providers Delegatus already supports
  beside OpenAI (OpenRouter for the three classifiers, the other speech
  providers for read aloud). PR #4416 adds no third feature on Plus: it
  moves part of a voice call that is already counted.

What PR #4416 adds to this step is narrow and the step says so: a call on
the API voice backend runs its delegation turns on the plan while its audio
stays on the key. A person whose voice runs through Codex gains nothing from
that sign-in today.

Moving the three classifiers onto the plan route would need them rebuilt as
ordinary Responses requests. The study finds it permitted with express
consent for the signed-in person's own activity, and unmeasured for quality,
for the 1.5 s budget and for the allowance it would spend. It stays out of
onboarding (section 10).

### 6.3 What the step shows

In this order, at both widths:

1. **One sentence of what the plan covers,** by tier. Pro and Business: "Your
   ChatGPT plan can pay for all six. Two run on your Codex sign-in. Four use
   an API key paid from the plan's API credits." Plus: "Your ChatGPT plan
   runs two of these. The other four need an OpenAI API key, billed
   separately."
2. **The key block.** A heading with its status dot ("API credits from your
   plan" on Pro and Business, "OpenAI API key" otherwise), one sentence on
   where the key comes from with the link to OpenAI's claim instructions, one
   field, Save.
3. **Continue with ChatGPT** (slice 6, once PR #4416 has merged): that
   lane's button and states, with one line under it saying what it changes:
   "Calls on the API voice run their delegation on your plan."
4. **The six rows in two groups,** each row with the feature's name, the
   existing one-line description (`openaiServices.what.*`) and its switch.

| Group heading | Rows | While the group waits |
|---|---|---|
| "On your ChatGPT plan" | Voice Delegatus, Dictation | "needs a Codex account signed in with ChatGPT" |
| Pro and Business: "With the API key · paid from your plan's API credits once claimed". Otherwise: "With the API key · billed to your OpenAI API balance" | Read aloud, Asks you, Memory in chats, Learned rules | "needs the key above" |

What a group waits for is said once, in its heading, and leaves each row its
width. A row adds a line of its own only for a reason the heading cannot
carry: an environment lock ("Set by LLV_TRANSCRIBE_BACKEND", the sentence
Keys already shows), a Codex sign-in the Viewer cannot read for dictation,
or a refusal when the switch was applied.

Delegatus cannot read a credit balance from a key. So the step never states
that the credits cover the key that was pasted. After Save the block reads
"Key saved. If its project is linked to your plan, the plan's API credits
are spent first." The prototype's shorter sentence claimed more than the
product can know.

### 6.4 What a switch writes

The answers to Q1 and Q2 carry over to six switches: each is on by default
when its route is available, nothing is written while the person looks at
the step, and Continue applies the switches that are on. Saving the key
moves no feature by itself, as decided on 2026-10-29. A feature that already
has a saved choice shows that choice, and its switch starts where the choice
puts it.

| Control | Call | What it changes | Refusals the control shows |
|---|---|---|---|
| Save, beside the key field | `PUT /api/keys/openai` (`src/app/api/keys/[id]/route.ts`) | stores the key; no feature moves | `invalid_key`, `set_by_env`, `staging`, `write_failed`, and the owner gate's `owner_required` |
| Voice Delegatus | `PUT /api/openai-services` with `codex`, then "Show the voice" through `PUT /api/voice-companion/settings` | the backend and the feature's own switch | `unavailable` |
| Dictation | `PUT /api/openai-services` with `chatgpt` | the dictation backend | `locked_by_env`, `unavailable` |
| Read aloud | the same route with `openai` | the speech backend | `locked_by_env`, `unavailable` |
| Asks you | the same route with `openai`, then `enabled` through `PUT /api/asks-you` | the classifier's provider and the feature's own switch, which is off on a new install (`src/lib/asks/settings.ts:58`) | `unavailable`, `operator_only` |
| Memory in chats | the same route with `openai` | the classifier's provider only | `unavailable` |
| Learned rules | the same route with `openai` | `rulesProvider` (`policy.ts:112–114`) | `unavailable` |
| Continue | the calls above, one feature after another, for each switch that is on | — | a refused feature keeps its row on screen with the reason, the others stay applied, and the step does not advance until the person presses Continue again or turns that switch off |
| A switch turned off | nothing | the feature keeps whatever serves it today | — |

Every `PUT /api/openai-services` can also answer `staging` and
`write_failed` (`src/app/api/openai-services/route.ts`), and a row shows
either in the same place as its own refusals.

Three things follow from the code, and the step states each of them:

- **Memory in chats is switched per project** (`sharedMemoryEnabled`,
  `src/lib/memory/settings.ts:26–34`), and the guide has no project yet at
  this step. The row chooses who serves memory. The project's own switch
  stays in the project's settings and in the Memory step.
- **Learned rules already use OpenAI by default once a usable key exists**
  and no choice was saved (`policy.ts:68–75`). Its switch records the choice
  explicitly. Turned off, it writes nothing, and the row says "uses the key
  when one is saved" so the switch never promises more than it does.
- **A switch that is off moves nothing back.** Choosing another provider for
  a feature stays in Settings → Keys, one press away from each row's name.

The step adds no route and no gate. Its calls pass three existing ones:

| Gate | Routes | What it refuses |
|---|---|---|
| `keysOwnerGate` (`src/lib/keys/access.ts:41–49`) | the key, `/api/openai-services` | a cross-origin request; a request from an agent or from outside a Delegatus page (403 `operator_only`); a team member (403 `owner_required`); a staging release (409 `staging`) |
| `requireOperatorAuthority` | `PUT /api/asks-you` (`src/app/api/asks-you/route.ts:25–29`) | a cross-origin request; a caller without operator authority (`operator_only`) |
| `companionOperator` | `PUT /api/voice-companion/settings` (`src/app/api/voice-companion/settings/route.ts:15–17`) | a caller that is not the operator |

The key and the provider routes already tell the page whether the reader is
the owner, and the step takes its cue from that answer: a team member sees
the rows and their state with every control disabled and one sentence saying
the owner sets them. What the other two gates answer to a member is read
and tested by the slice that builds the step (section 12, slice 5).

### 6.5 States

| State | What the step shows |
|---|---|
| Codex on Pro or Business | the six-of-six sentence, the credits block with the key field, both groups; the key group waits for the key |
| Codex on Plus | the two-of-six sentence, "Plus has no API credits. A key works too and bills your OpenAI API balance.", both groups |
| Key saved | the key group's switches come on; the block's sentence about the credits (section 6.3) |
| Sign-in in progress (slice 6) | "Finish signing in in the browser tab." and Cancel |
| Connected (slice 6) | the one-time line "You're using your ChatGPT plan" with "Got it", and "Manage usage" |
| The plan's limit is reached (slice 6) | the limit in words and "Manage usage" as the filled button, as OpenAI's guidelines for this sign-in ask |
| No ChatGPT subscription | the step is under "Later, any time"; the plan group waits and offers "Go to accounts"; the key block and its group work |
| Browser on another device (slice 6) | "Open Delegatus in a browser on the computer that runs it to sign in with ChatGPT." The key field and every switch work from anywhere |
| The plan sign-in absent or off in this build | everything except item 3 of section 6.3; this is the step as slices 1 to 5 ship it |

The step is skippable like every other: "Skip for now" is its footer button
until a key is saved or a switch has something to apply.

Which button is filled follows what the step can do from where it is opened:

| State | Filled button |
|---|---|
| A group can apply at least one switch (the plan group with Codex signed in, or the key group with a key saved) | the footer's Continue |
| Nothing can apply yet and the key field is empty | Save, beside the key field |
| Sign-in in progress (slice 6) | none: the next act is in the other tab |
| The plan's limit is reached (slice 6) | Manage usage |

In the guide the button "Continue with ChatGPT" takes the bordered style.
Lane c71f4a65 draws it filled in its Keys row, where it is the row's only
act. Here its one effect is on the API voice, the step's main act is
applying the six switches, and a screen holds one filled button. OpenAI's
guidelines for the button fix its label and leave its style to the app.

### 6.6 The switch's contrast

`SettingSwitch` (`src/components/ProjectSettingRow.tsx:41`) draws an off track
in the strong border colour, which is 1.7:1 on the card in both themes, and
fades a disabled switch to 45%. In the dark theme a disabled, off switch is a
dark track on a dark card. The step needs that state: the features that wait
for the key are off and disabled until it is saved. The build changes the
switch itself: an off track's outline takes the muted text colour (about 5:1
on the card in both themes), and a disabled switch keeps that outline whole
and steps its knob back to the strong border colour. The prototype applies
the same two rules from outside the component, and its driver measures every
switch's outline against the surface under it: 3:1 or more.

The component is shared. Seven files draw it: `ProjectSettingRow.tsx`,
`AccountSpendCredits.tsx`, `voiceCompanion/VoiceToolsSetting.tsx`,
`settings/settingsRows.tsx`, `memory/MemorySourceRow.tsx`,
`externalRelay/ExternalRelaySection.tsx` and `keys/OpenAiServices.tsx`, all
under `src/components/`. The slice that changes it renders the Settings
window in both themes through the kanban driver and measures the same 3:1
there.

## 7. macOS, Windows, Linux

| | Linux | macOS | Windows |
|---|---|---|---|
| Detection | as today | as today, plus Homebrew and `Codex.app` | as today; add `%LOCALAPPDATA%\agy\bin\agy.exe`, where the vendor's PowerShell installer puts Antigravity |
| Install button: Claude Code, Antigravity | vendor `install.sh` (probed) | the same scripts; they name darwin and clear the quarantine flag (read, unprobed) | the row shows the vendor's PowerShell line to copy and points at the step's "Check again"; no button until it is probed on Windows |
| Install button: Codex | package through the updater | the same | none: Codex needs WSL 2; the row says so, and inside WSL the Linux column applies |
| Sign-in: Claude, Codex | as today | as today | as today (Codex inside WSL 2) |
| Sign-in: Antigravity | `agy` in a terminal, then Check | the same | the same, in PowerShell |
| ChatGPT plan sign-in | needs a browser on the host | the same | the same |
| Viewer in a container | no button; the command for the host, and the step's "Check again" | — | — |

A musl-based Linux gets the vendors' musl builds from the same scripts. A
system with less than 1 GB free gets the `no_space` sentence before anything
is downloaded.

## 8. Variants

Each pair differs in one thing and shares its copy. Frames are in
`$LLV_EVIDENCE_DIR/onboarding-v2/`; the name is `screen-vN-state-width-language-theme`.
The operator chose one of each pair on 2026-11-25. The variant that was not
chosen stays described here and is not built.

### 8.1 Welcome

1. **Welcome, then the check.** A cover with the mark, one sentence, three
   numbered lines of what follows and "Start". The accounts appear on the next
   screen.
2. **Welcome with what was found.** The same head, then the agent programs
   this computer has, each with its state in the Accounts step's own row head,
   and the question about one more account. With accounts found, "Continue with these" skips the accounts
   step.

Recommended: **2**. The requirement puts the check and the question right
after the welcome, and variant 2 answers both on one screen: a person whose
accounts are already there reaches Roles in one press.

**Chosen: 2.**

### 8.2 Accounts

1. **Rows.** One list in the language of the Settings rows: a row per program,
   the state as a line of text with a dot, one action at the row's end, the
   sign-in block or the accounts unfolding under the row.
2. **Cards.** Today's two-column engine cards with the engine's colour on the
   edge, with Install and Sign in where the command and the account panel
   stood.

Recommended: **1**, with the trade-off stated. Rows read as one scan line per
program: name, state, and the action always at the row's end, in the row
pattern Settings already uses, and they continue the list Welcome 2 starts.
With one account per program all four rows and their actions fit the first
screen at both widths. Cards are today's layout, so they cost a returning
user nothing to relearn, and on a desktop they show two programs' account
lists side by side where rows stack them (`accounts-v2-several-1440-*` beside
`accounts-v1-several-1440-*`). In a card the state line and its button sit on
different lines, and on a phone both variants are one column. The current
guide chose cards, so replacing them is the operator's call (Q7).

**Chosen: 1, rows.** The cards of today's guide are replaced.

### 8.3 Roles

1. **Summary by group.** Five lines (Build, Review, Design, Coordination,
   Rarely used), each with the runtimes its roles start on and "Change", which
   unfolds that group's rows. On a desktop the group's name keeps a fixed
   column and the runtimes take the width up to "Change", so the first two
   and "and N more" keep one line in both languages.
2. **Whole table.** Every row with its controls, grouped, the rare ones
   folded. On a phone every row with its runtime, one open at a time
   (section 5).

Recommended: **1**. The step's job is to show the defaults and offer a change.
Five lines can be read in a few seconds and fit a phone without scrolling; the
whole table is nineteen rows and is already one press away, here and in the
menu.

**Chosen: 1.**

### 8.4 ChatGPT plan

1. **One button.** The plan sign-in, the features it runs as plain lines, then
   the credits block with one field and one switch for all four key-backed
   features.
2. **Feature list.** The plan sign-in and the key field first, then the six
   features as rows with their own switches, in two groups: on the plan, and
   with the API key. A group that still waits says so once, in its heading
   ("needs the key above").

Recommended: **1**. The requirement asks to switch everything on at once.
Per-feature choice already exists in Settings → Keys, and six switches in a
first run ask for six decisions from a person who has not used any of the
features yet.

**Chosen: 2, the feature list.** The operator wants each feature and its
route in view. The cost named above is met by the defaults: every switch
whose route is available starts on, so a person who presses Continue makes
no decision and gets what the one switch of variant 1 would have given
(section 6.4). The single switch for all four is not built.

## 9. Questions and the operator's answers

All seven are settled. Q1 to Q6 were answered on 2026-11-25 as recommended;
the choice of Accounts 1 answers Q7. The questions stay as they were asked.

**Q1. "So the API key passes over".** The ChatGPT sign-in gives an app no API
key, and OpenAI documents no way for an app to claim a plan's API credits. The
outcome behind the sentence appears to be: the API-backed features run on the
subscription with as few steps as possible.
- (a) Build the step around that outcome: the plan sign-in, plus one pasted
  key and one switch for the features the plan route does not serve.
  **Recommended.**
- (b) Leave the key out of the guide; the step offers the plan sign-in only,
  and four features stay off until Settings → Keys.
- (c) Wait until OpenAI offers a hand-over.

Answered: **(a)**. The comment that came with the answer is taken up in
section 6.

**Q2. "Switch on all the features at once" and the decision of 2026-10-29**
(no feature moves to OpenAI when a key is saved). Recommended: one switch in
this step, on by default, that moves the four key-backed features when the
person presses Continue; saving a key anywhere else still moves nothing.

Answered: **on by default, applied by Continue**. With ChatGPT plan 2 chosen,
the same answer governs each of the six switches (section 6.4).

**Q3. Running vendor installers from the Viewer.** This was deferred on
2026-11-10 as a new trust boundary. Recommended: accept it with the guards of
section 4.3 (fixed addresses, a downloaded file with a recorded hash, the
Viewer's own user, no elevated rights, the owner only, no container), and
install Codex as a package at the newest reviewed version through the existing
updater. The alternative for Codex is the vendor script, which installs the
newest release whatever this product was last read against and edits the
shell profile.

Answered: **accepted, with those guards; Codex as a package of the reviewed
version through the updater.**

**Q4. Roles written on Continue.** With one engine signed in, the step moves
up to seventeen rows of the mapping when the person continues. Recommended:
yes, with the existing Undo receipt; the orchestrator step stops moving rows.

Answered: **yes.**

**Q5. Copilot.** The requirement names three programs; the guide has a
Copilot card today. Recommended: keep Copilot as the fourth row with its
current instruction and no Install button.

Answered: **keep it as the fourth row, with no Install button.**

**Q6. Platforms for the first build.** The installers were run on Linux only.
Recommended: the button on Linux and macOS (macOS after one probe on a Mac),
the copyable PowerShell line on Windows.

Answered: **as recommended.**

**Q7. Rows or cards for the accounts.** The guide shows engine cards today.
Recommended: rows (Accounts 1), for the reasons in section 8.2; cards
(Accounts 2) keep today's look and carry the same Install and Sign in.

Answered: **rows.**

## 10. Deferred — not currently justified

- **A terminal inside the guide for the Antigravity sign-in.** Lane 97ed7f10
  chose the command and a check. Revisit if people fail at that step.
- **Installing onto the host from the Viewer in a container.** Needs a route
  out of the container; nobody has asked.
- **Installing with elevated rights, or system-wide.** All three installers
  work in the user's home.
- **An Install button for Copilot.** Outside the requirement.
- **An Install button on Windows.** Waits for a probe on Windows.
- **Uninstall, repair and version choice for Claude Code and Antigravity.**
  Codex has its updater and Claude Code updates itself; how Antigravity
  updates was not examined.
- **A progress percentage.** The installers print none; faking one would
  misreport.
- **Installing without a press** (on first run, or when a role needs a missing
  engine). The requirement says "with a button".
- **Claiming the plan's API credits from inside Delegatus,** and showing
  their balance. No documented route for either, and a key does not reveal
  the balance behind it. Revisit when OpenAI documents one.
- **The three classifiers rebuilt as Responses requests on the plan route.**
  This is the only way Asks you, Memory in chats and Learned rules could run
  on the sign-in with no key, which would bring a Plus plan from two features
  to five. The study finds it permitted for the signed-in person's own
  activity with express consent, and unmeasured: answer quality without
  predicate probabilities, completion inside memory's 1.5 s, and the plan
  allowance each call spends. It needs the plan client of PR #4416, a
  consent record per feature, and a measurement run on a ChatGPT plan that
  the operator authorizes. If it is ever tried, it starts with Asks you on a
  solo install, which runs outside the prompt and launch paths
  (`onboarding-v2-subscription.md`, "What a classifier move would change").
- **Read aloud and live audio on the plan route.** OpenAI's plan route
  carries no audio. Revisit when it does.
- **One switch for all four key-backed features** (ChatGPT variant 1). The
  operator chose the feature list on 2026-11-25. Per-feature switches left
  this list that day.
- **The welcome as a cover, accounts as cards, roles as the whole table**
  (Welcome 1, Accounts 2, Roles 2). Not chosen on 2026-11-25. The whole
  table stays in the menu under "Agent mapping".
- **Choosing another provider inside the plan step** (OpenRouter for a
  classifier, another speech or dictation provider). Stays in Settings →
  Keys and in the Voice step.
- **Switching memory on for a project from the plan step.** The guide has no
  project at that point; the project's own switch stays where it is.
- **One call that applies all six switches.** Six calls to the existing
  route, one after another, do it with no new server code.
- **Choosing which account a role uses.** Account rotation already decides.
- **Redesigning Project, Orchestrator and the later steps.** Outside the
  requirement.
- **A gate that stops the guide until an engine is signed in.** The guide's
  standing rule is that nothing is gated; the footer's wording carries the
  message.

## 11. Check against the requirement

| The requirement asks | The design answers |
|---|---|
| Audit: what launches, what does not | Section 2, run in an isolated install, with frames |
| A welcome first | Section 3.1; variant 2 chosen |
| Check which accounts exist, ask whether to add one | The welcome's list and the accounts step |
| Install Claude Code, Codex and Antigravity by button | Section 4.3, with measurements and guards; slice 3 |
| Sign in from the interface | Section 4.4; Antigravity through lane 97ed7f10's path |
| Default roles that take the accounts into account, with an offer to change | Section 5; slice 4 |
| With Codex on a ChatGPT subscription, offer the ChatGPT sign-in | Section 6.3, item 3, embedding lane c71f4a65; slice 6 |
| "So the API key passes over" | The sign-in gives no key (section 6.1). The plan's API credits reach Delegatus through one key the subscriber creates |
| Offer to switch on all API-backed features at once | Six switches, on by default, applied by Continue (section 6.4) |
| "Pro subscriptions include API usage" | True as monthly credits used through a key; the step's key block says so and links the claim instructions |
| Design and prototype only | No product file changes; one fixture and one driver block |

And against the comment that came with the decision (section 0.1):

| The comment says | The design answers |
|---|---|
| The sign-in on the subscription gives an API key | It gives none; OpenAI's help page says so in those words (section 6.1) |
| That key could serve Decisions too | A key linked to the plan's credits does serve Decisions: OpenAI's credits guide lists Decisions among the covered usage. The step now says which group the credits pay for (section 6.3) |
| The step does not account for it | The decided step names every feature with its route and who pays, by tier (sections 6.2 and 6.3) |
| All or nearly all features on the subscription | Pro and Business: six of six, after one pasted key. Plus: two of six, and the four others cannot move without a key or another provider (section 6.2) |

Not requested and left out: everything in section 10.

## 12. The build plan

Six slices. Each works without the ones after it. Slices 1 to 5 need nothing
from PR #4416; slice 6 is the only one that waits for it.

```
1 defects ─► 2 welcome + accounts ─┬─► 4 roles ─► 5 plan step with the key ─► 6 plan sign-in
   (none)       (after #4473)      │   (after #4473)    (no open pull request)      (after #4416)
                                   └─► 3 install job, in its own lane beside 4 and 5
```

If PR #4473 is slow to merge, slice 5 moves up to follow slice 1: it adds a
step to the list and touches none of the files that pull request rewrites.

### 12.1 What every slice shares

- **Branch and base.** A slice starts from `main` once its dependencies have
  merged. This document and the prototype are its reference.
- **Open pull requests on the same files,** read on 2026-11-25. Whichever
  side merges second rebases.

  | Pull request | Files it shares with the slices | Slices |
  |---|---|---|
  | #4473, agent mapping and Antigravity sign-in (lane 97ed7f10), checks green except the native Windows job, which is also red on #4416 | `EnginesStep.tsx`, `OnboardingDialog.tsx`, `AgentMappingTable.tsx` and their tests, `src/app/api/accounts/cli/route.ts`, `src/lib/onboarding/agentInstallCommands.ts` | 2 and 4 wait for it; 1 shares `OnboardingDialog.tsx` |
  | #4416, Sign in with ChatGPT (lane c71f4a65); its description records the last fix as not re-reviewed | `src/components/keys/KeysSection.tsx`, `OpenAiServices.tsx` and their tests, the kanban and phone drivers | 5 shares export lines; 6 waits for it |
  | #4268, retiring a Codex model, last updated 2026-11-20 | `OrchestratorStep.tsx`, `OnboardingDialog.dom.test.tsx`, `src/lib/roles/equivalents.ts` | 1 and 4 |
  | Many others | `src/lib/i18n/en.ts`, `uk.ts` | all |

- **Tests.** By path only, through `scripts/gate-slot.sh`, with a private
  `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR`. No slice runs the
  whole suite, a whole-program typecheck or a build before publication.
- **Rendered evidence through the drivers that exist.** The kanban driver
  already renders the real guide: the block "first-run guide: variant 1 on
  the real components"
  (`src/components/kanban/kanbanBoard.browser.test.tsx:44781`). Each slice
  adds its states to that block. The phone goes through
  `src/components/mobile/issue1671Evidence.browser.test.tsx`, which opens the
  guide by its own event. No slice adds a driver or a file named after an
  issue.
- **Widths, languages, themes.** 1440, 860 and 390 (the guide changes layout
  at 859 px), in Ukrainian and English, light and dark, each state scrolled
  until its changed strings are whole.
- **Checks every frame carries,** taken over from the prototype's driver
  (section 13): the heading and the main button on the first screen; one
  filled button, or none in a state that waits on something outside the
  page; a status dot before its words and on their line; words for every
  status that is not green; no sideways overflow; 44 px targets under a
  finger; a popover inside the window and over no words, measured from text
  ranges; no English fallback in a Ukrainian frame.
- **Review size.** S is one review round, M is two, L is three. Every slice
  that changes a screen also takes the visual critic.

### 12.2 Slice 1: two standing defects

- **Scope.** A9: while the guide is open, the first-run telemetry notice is
  drawn inside the guide, as a line above its footer with the notice's two
  actions, and the fixed notice at the toast layer waits until the guide
  closes. The notice's words stay on the first screen. A5: with no engine
  signed in, the orchestrator step names what is missing and offers the way
  to Accounts; it stops reading "Runs on Claude".
- **Files.** `src/components/telemetry/TelemetrySettings.tsx:39`,
  `src/components/onboarding/OnboardingDialog.tsx`,
  `src/components/onboarding/OrchestratorStep.tsx:65`, the two language
  files.
- **Depends on.** Nothing.
- **Tests.** `src/components/telemetry/TelemetrySettings.dom.test.tsx`:
  the notice inside the open guide with its two actions, and the fixed
  notice once the guide is closed. `OnboardingDialog.dom.test.tsx`: the
  orchestrator step with no engine.
- **Evidence.** A true first visit at 390, 860 and 1440: the footer's button
  is whole, measured from its text range against the notice's box, and the
  press on Continue lands (the audit's press was refused).
- **Review.** S.
- **Built, 2026-11-26.** A9: the guide holds a place for the notice between
  its body and its footer (`TelemetryNoticeSlot`), in every mode of the
  dialog, and the notice host draws its line there while a guide is mounted.
  A5: the "Runs on" row carries the statement and the way ("Connect Claude or
  Codex first.", "Go to Engines"), so both are on the first screen at every
  width; the plan sentence and the cost estimate, which named the same
  runtime, are not drawn; a missing project is said the same way in the
  "Project" row ("Pick a project first.", "Go to Project"), and no block
  below the step's notes repeats it. Frames: the
  states `first-visit*` and `orchestrator-no-engine` of the kanban driver's
  guide block.

### 12.3 Slice 2: the welcome and the accounts as rows

- **Scope.** Sections 3.1 and 3.2 with Welcome 2 and Accounts 1: one row per
  program with its state line, dot and one action; Sign in started from the
  row for Claude Code and Codex, using the sign-in blocks the accounts panel
  already has; the Antigravity row with lane 97ed7f10's command and "Check
  sign-in"; the Copilot row as a sentence; one "Check again" beside the
  heading; the footer's two wordings; "this computer" against "the computer
  running Delegatus". A program that is not installed shows its command to
  copy, as today, until slice 3. Windows rows follow section 7.
- **Stored ids stay.** The Accounts step keeps the stored id `engines` and
  changes only its label: the marker keeps progress only for ids it knows
  (`src/lib/onboarding/marker.ts:68`), so a renamed id would forget a
  finished step. The welcome is no step and adds no marker field. It is the
  guide's first view when the guide opens by itself with no step settled.
- **Files.** `OnboardingDialog.tsx`; `EnginesStep.tsx` rewritten as rows,
  with `EngineCardParts.tsx` and `AntigravityCard.tsx` from #4473 folded
  into them; a new `WelcomeStep.tsx`; `src/components/AccountsPanel.tsx`
  (the sign-in blocks a row embeds, and "Add an account");
  `src/components/CopilotFooterRow.tsx`;
  `src/lib/onboarding/agentInstallCommands.ts` (the PowerShell lines, with
  their segments); the two language files.
- **Depends on.** PR #4473 merged: it rewrites the same card files and
  supplies Antigravity's probe and sign-in block.
- **Tests that assert what this slice replaces.** In
  `EnginesStep.dom.test.tsx`: "with no tool at all there is exactly one
  Check again, on the first card", "the Check again button moves to the next
  card", "none connected puts its warning above the cards", and the case
  that reads the install command on a card. In `OnboardingDialog.dom.test.tsx`:
  the cases that number the steps and name the first one ("without a bot the
  guide numbers Engines, Project and Orchestrator…", "with a bot already
  connected…", "#2166: a six-step marker with Engines done lands on
  Project…"). #4473's
  `AntigravityCard.dom.test.tsx`. The kanban block's selectors for engine
  cards, the install command and the recheck button
  (`kanbanBoard.browser.test.tsx:45039–45043`).
- **Evidence.** Both welcome states and every state of the table in section
  3.2. The driver counts four program rows against the program list, one
  dot per row, and one "Check again" outside the rows.
- **Review.** M.
- **Built, 2026-11-26.** The step reads Accounts and keeps the id `engines`.
  `EnginesStep.tsx` is the four rows; `ProgramRowParts.tsx` holds what a row
  and the welcome share (the mark, the name, the state line and its dot, the
  command to copy), and `AntigravityAccount.tsx` keeps Antigravity's read,
  its terminal sign-in and the body the sidebar footer and the phone's
  accounts screen draw. `EngineCardParts.tsx` and `AntigravityCard.tsx` are
  gone. `AccountsPanel.tsx` exports the sign-in block a row embeds
  (`AccountSignInBlock`) and the form that names a new account
  (`AddAccountForm`); `CopilotFooterRow.tsx` needed no change, the row reads
  its existing account hook.
  - *The welcome* (`WelcomeStep.tsx`) is shown when `useOnboarding` opened
    the guide itself and the marker holds no settled step. "Continue with
    these" marks `engines` done and opens Project, the step after Accounts
    until Roles is numbered (slice 4). A third state stands beside the
    table's two: programs installed and nobody signed in, whose button reads
    "Sign in to an account".
  - *Until the install job exists* (slice 3) the nothing-found state says
    "The next step shows the command that installs each one" where the table
    says Delegatus can install one, and the Accounts lead leaves out the
    sentence about installing into the home folder.
  - *Rows.* A dot's popover holds one or two short lines: what the state
    line leaves out, and for a signed-in account the share of its session
    limit left with the hour it starts over. An installed, signed-out
    program's popover names its version and the path its command was found
    at ("Version 2.1.4 at ~/.local/bin/claude"); a signed-in one's names the
    version and the limit left, or the version and the path when no limit
    has been read. Both come from the check the rows already wait for: the
    one bounded `--version` run per program that says whether the command
    starts (`cliReport` in `src/lib/accounts/engineConnection.ts`) also
    keeps the resolved path and the first dotted triple of a clean answer.
    `GET /api/accounts` and the re-probe `GET /api/accounts/cli` carry them
    as `cliInstalls`, for Copilot too. A path under the home reads from
    `~`, so the answer carries no user name; a command found through PATH
    alone has no path, and a `--version` that fails has no version, and
    then the popover says the part that is known or keeps its sentence. A
    path longer than a popover's line keeps its last folders and the file
    behind "…". A program that is not installed never quotes either. The
    popover is placed against the row's name and state alone, so
    it ends before an action beside them. Under 768 px the list is about
    300 px wide (a phone, and a window where the step list stands beside
    it): beside "Claude Code" that leaves a popover some 130 px, which two
    short lines do not fit. There a row's action stands under its head and
    the dot's words open in the row itself, under the state line, where
    they cover nothing. Words that open there stand right under the line
    their dot leads, so they add only what that line leaves out: under
    "12% of the session limit left" an amber account's note reads "Resets
    at 11:35." alone. Where the words say all of it (no hour known, "needs
    sign-in", "signing in") the dot opens nothing there. The
    floating popover of a wide card keeps both sentences, and the dot's
    label for a screen reader keeps both at every width. Escape closes an
    open popover alone and the next
    Escape closes the guide. The footer reads "Continue without an agent" on a border until
    Claude Code, Codex or Antigravity has a signed-in account, and the
    visited step's warning mark in the list follows the same rule.
  - *This computer.* True when the page was reached at a loopback address on
    a screen that is not a phone, the signal `/api/chatgpt-plan` already
    reads; otherwise the sentence names the computer running Delegatus.
  - *Windows.* `GET /api/onboarding` names the host's system. On `win32` a
    missing row shows the vendor's PowerShell line (all three answered on
    2026-11-26) and Codex reads "Needs WSL 2 on Windows". Antigravity's
    line installs `%LOCALAPPDATA%\agy\bin\agy.exe` and extends the user's
    PATH, which a Delegatus that is already running never sees, so the
    Windows search probes that folder for `agy` by name: from
    `LOCALAPPDATA`, then from its usual place under the home
    (`windowsAgentBinaryCandidates` in `bin/agent-binaries.mjs`, the one
    list the launcher and the Viewer's resolver in `src/lib/agent/cli.ts`
    both read). "Check again" after the install finds it with no restart.
  - *The guide no longer carries* the provider form, the usage header or
    "Remove": they stay on the accounts screen (A3).
  - *Frames:* the states `welcome-*`, `engines-*` and `accounts-*` of the
    kanban driver's guide block, at 1440, 900, 860, 645 and 390; 860 in
    both themes, as 1440 and 390 are. The block presses every dot and
    checks that a signed-out program's popover names its version and path,
    a signed-in one's its version, and that words opened in a narrow row
    repeat nothing of the line above them.

### 12.4 Slice 3: the install job and its button

- **Scope.** Section 4.3 whole, on Linux. macOS shows the button after one
  recorded run of the three installers on a Mac in an empty home; until then
  its rows show the command.
- **Files.** New `src/lib/agentInstall/` (the compiled table of sources, the
  job, the process-group runner, the log). New routes
  `src/app/api/accounts/install/route.ts` and `[operationId]/route.ts`,
  shaped like `src/app/api/accounts/claude/login/[operationId]/route.ts`.
  `src/lib/codexUpdate/production.ts` and `installation.ts`. The accounts
  rows (Installing, Install failed). The two language files.
- **Codex needs a first-install entry.** `updateCodex` begins from a binary
  that is already installed (`src/lib/codexUpdate/update.ts:68`), and
  `installedTarget` accepts only a link into
  `node_modules/@openai/codex/bin/codex.js` (`installation.ts:14–24`). The
  first install reuses the updater's `install` and `probe`
  (`production.ts:131`, `:164`), then creates that link in a folder
  `agentBinaryCandidates` searches (`bin/agent-binaries.mjs:6`), so the
  updater recognizes the result from then on. The version is the newest
  directory of `src/lib/accounts/protocol/`, 0.170.0 when read.
- **What the route answers under each gate.** A cross-origin request is
  rejected. A request from an agent answers 403. A team member answers 403
  and sees no button. A staging release answers 409. A Viewer in a container
  answers 409 with the command for the host. A second request for the same
  program joins the running job.
- **The installer keeps the real home.** It installs into the user's home,
  so it runs with the Viewer's own environment. The agent sandbox
  (`withAgentConfigSandbox`) would send it to a scratch home. The job's
  directory lives in the Viewer's state and only the Viewer writes it.
- **Depends on.** Slice 2 for the row. Nothing in #4416, slice 4 or slice 5;
  its files are new apart from the rows.
- **Tests.** The job against a stub server on a port the system assigns,
  serving a script: the size limit; the recorded path and SHA-256; a
  password prompt failing on closed input; the time limit on a shortened
  clock; Cancel ending the recorded process group and nothing else; every
  failure code of section 4.3. Each runs with `HOME` under the temp root. A
  route test per gate. `src/lib/codexUpdate/update.test.ts` and
  `production.test.ts` for the first install. No test downloads from a
  vendor.
- **Evidence.** The Installing and Install failed rows at three widths, and
  one recorded real install per program in an empty scratch home.
- **Review.** L, with a security review: the Viewer downloads and runs a
  vendor's code as the user, which is a new trust boundary.

### 12.5 Slice 4: roles as a numbered step

- **Scope.** Section 5 with Roles 1: five group lines, "Change" unfolding a
  group, the rule over three engines, the write on Continue through
  `PUT /api/roles`, the receipt with Undo. The orchestrator step stops
  moving rows.
- **Files.** `src/lib/onboarding/steps.ts` (`agents` moves from the later
  list to the numbered one and keeps its stored id; its label becomes
  "Roles"); a new `RolesStep.tsx`; `AgentMappingTable.tsx`, where
  `oneEngineMove` (`:147`) answers only for exactly one of Claude and Codex
  and becomes the rule of section 5, and the receipt hand-over (`:174`) is
  reused; `OrchestratorStep.tsx:139–159`; `OnboardingDialog.tsx:273`, where
  Antigravity's `connected` reads the probe #4473 adds. Read and left alone:
  `src/lib/roles/equivalents.ts:136`, `src/lib/roles/locks.ts`,
  `src/app/api/roles/route.ts`.
- **Depends on.** PR #4473 (the icon segments, Antigravity's state) and
  slice 2.
- **Tests.** The rule for the five rows of section 5's table, with the
  counts computed from the role catalogue. Undo restoring exactly what each
  row was. `AgentMappingTable.dom.test.tsx` from #4473, and the two cases of
  the table's own one-press move ("a saved role memory cap survives … the
  bulk move", "the visual critic's row cannot move to Codex…"), which runs
  on the same function. In
  `OnboardingDialog.dom.test.tsx`: four cases assert what this slice removes,
  the move made when the orchestrator is created ("one engine: the step
  names the roles that move…", "one engine, Undo…", "only Codex: 7 roles
  move…", "a refused move keeps the step open…"; the seven there excludes
  the orchestrator's own row, which the new rule moves as an eighth). Every
  case that presses Continue past Accounts with one engine signed in now
  passes through Roles and its write. The builder lists those cases and says
  for each whether it stubs the write or asserts it.
- **Evidence.** The five lines counted against the five groups and the open
  table against the catalogue's rows; a group's runtimes on one line on a
  desktop; at most one row open on a phone.
- **Review.** M.

### 12.6 Slice 5: the ChatGPT plan step, with the key and the six switches

- **Scope.** Section 6 without item 3 of section 6.3: the tier sentence, the
  key block, the two groups, the six switches, Continue applying them.
- **Files.** `steps.ts` (a new id `chatgpt`; `onboardingStepLists` takes a
  second input, whether a Codex account is on a ChatGPT subscription, and an
  older marker reads the new id as not visited); a new `ChatGptPlanStep.tsx`;
  `OnboardingDialog.tsx`; `src/components/keys/OpenAiServices.tsx`
  (`featureName`, the descriptions and `useOpenAiServices` are reused;
  `:45–56`, `:177`); `src/components/keys/KeysSection.tsx` (the key write,
  `:160`, exported); `src/hooks/useVoiceCompanionSettings.ts`;
  `src/components/ProjectSettingRow.tsx` (section 6.6); the two language
  files. No server file changes.
- **The tier.** Read from the Codex account's plan as the accounts answer
  already carries it (`planType`, `src/lib/accounts/codexAppServer.ts:68`).
  An unknown tier gets the Plus wording, which promises less.
- **Depends on.** Nothing open. It shares `steps.ts` and
  `OnboardingDialog.tsx` with slices 2 and 4, and export lines of the two
  Keys files with #4416.
- **Tests.** `ChatGptPlanStep.dom.test.tsx`: every state of section 6.5; the
  defaults; nothing written before Continue; each call of section 6.4; each
  refusal on its row (`locked_by_env`, `unavailable`, `invalid_provider`,
  `staging`, `write_failed`, `invalid_key`, `set_by_env`, `operator_only`);
  a refusal in the middle leaving the applied features applied and the step
  in place; a team member's view, with what each of the three gates answers
  to a member; six rows counted against `SERVICE_FEATURES`.
  `OpenAiServices.dom.test.tsx`, `KeysSection.dom.test.tsx` and
  `src/lib/openaiServices/policy.test.ts` pass unchanged. In
  `OnboardingDialog.dom.test.tsx`, a Codex account on a ChatGPT plan now
  numbers one step more.
- **Evidence.** Pro, Plus, key saved, no subscription and team member in the
  guide block; the Settings window block
  (`kanbanBoard.browser.test.tsx:42688`) in both themes for the switch, with
  its outline measured at 3:1 or more; the phone driver.
- **Review.** M. The step switches paid features on by default, so its
  evidence is renewed after every later change to the slice.

### 12.7 Slice 6: the plan sign-in inside the step

- **Scope.** Item 3 of section 6.3 and the states of section 6.5 marked for
  this slice.
- **Files,** as of #4416's head `2baf3151e4d6`:
  `src/components/keys/KeysSection.tsx`, where `useChatGPTPlan` (`:592`) and
  `ChatGPTPlanRow` (`:670`) are local to the file and move to one shared
  component that the Keys row and the step both draw; `ChatGptPlanStep.tsx`;
  the two language files. `/api/chatgpt-plan` is used as it is.
- **Every state of that lane has a place.** `PlanState`
  (`src/lib/chatgptPlan/public.ts:4`) has twelve members:

  | Members | In the step |
  |---|---|
  | `off_staging`, `off_unconfigured`, `off_unsupported_platform` | item 3 is absent |
  | `remote_browser` | the sentence about a browser on the host |
  | `not_connected`, `plan_disabled`, `reconnect_required` | the button, with that lane's sentence for the state |
  | `connecting` | "Finish signing in in the browser tab." and Cancel |
  | `connected` | the one-time line, "Got it", "Manage usage" |
  | `plan_limit` | the limit in words, "Manage usage" filled |
  | `retry_later`, `error` | the button and the reason in words |

- **Depends on.** PR #4416 merged, and slice 5.
- **Tests.** One case per member, counted against the type's list. The Keys
  row's own tests from #4416 pass after the move.
- **Evidence.** Each row of the table above in the guide block and on the
  phone.
- **Review.** M: it moves an OAuth surface into a second screen.

### 12.8 When the prototype goes

`docs/design/onboarding-v2/` and the `describe` block "onboarding v2
prototype" in `src/components/conversation/conversationWindow.browser.test.tsx`
stay until slices 2, 4 and 5 have merged. The last of the three removes
them, moves any check its own block lacks, and searches the docs for their
names.

## 13. The prototype

The frames were drawn before the decision. The build follows sections 3 to 6
where they differ from a frame, in four places on the plan step:

| In the prototype's frames | In the build |
|---|---|
| Feature names of the prototype's own ("Spotting questions for you") | the names Settings → Keys uses (section 6.2) |
| "Key saved. Spending draws on the plan's credits first." | the conditional sentence of section 6.3; the product cannot see the credits |
| The key group's heading is "With the API key" on every tier | the heading says who pays, by tier (section 6.3) |
| "Continue with ChatGPT" filled, above the key | bordered, after the key block, and present only from slice 6 (section 6.5) |

Those four are new to a reader of the frames, so slice 5's evidence shows
each of them at the three widths before its review.

`docs/design/onboarding-v2/prototype.fixture.tsx` draws the four screens on
the product's stylesheet and components (`StatusDot`, `Select`,
`SettingSwitch`, `EngineMark`, `CopyButton`, the guide's own class recipes),
with invented data. Its buttons work: Install runs the three steps, Sign in
opens each engine's block, Continue carries the accounts into the roles, and
the plan step connects. `docs/design/onboarding-v2/README.md` has the address
parameters and the command.

The `describe` block "onboarding v2 prototype" in
`src/components/conversation/conversationWindow.browser.test.tsx` renders
every screen, variant and state at 1440 and 390, in Ukrainian and English,
light and dark, with the variant number printed on each frame, and checks each
frame: the caption's number, the heading and the main button on the first
screen, one filled button, no sideways cut or overflow, 44 px targets under a
finger, no English fallback in a Ukrainian frame, and the status popover
inside the window and over no words of the page, measured from their text
ranges. It also checks that a command breaks only between its segments, that
every Install button has its line and that a computer with nothing installed
shows all three lines on the first screen, that each row shows one dot beside
its name, that a summary names a model as its select does, that the key field
of ChatGPT variant 2 is on the first screen, and that the counter and the
rail number four steps or five by the frame's accounts. Since the second
review it checks six more things on every frame: one filled button, or none
in the three states that wait on something outside the page; every status dot
before its words and on their line; every state line on one line; words
beside every account dot that is not green; one "Check again", outside the
programs' rows, on the first screen, and named by each sentence that sends
the reader to it; and every switch's outline at 3:1 or more against the
surface under it. A phone frame may not say "this computer", shows at most
one role open, draws its role selects at regular weight, and in the whole
table shows eight roles or more on the first screen. One more pressed frame
opens the amber dot of an account among several, in both themes. Since the
third review it checks five more things on every frame: a state's words in a
status colour take their dot's tone; no card's edge is painted in a status
colour; the Copilot row holds no sign-in button and no sign-in block; a
group's runtimes keep one line on a desktop; and the roles' first paragraph
carries no bare number in parentheses. The amber account's popover must name
a share of the limit and a time, in two lines at most. A second case presses
the page's own buttons from the first screen to the last and reads the same
count of steps on Accounts and on Roles. Frames, `readings.json` and the index go to
`$LLV_EVIDENCE_DIR/onboarding-v2/` (`index.md`, `index.html`).
