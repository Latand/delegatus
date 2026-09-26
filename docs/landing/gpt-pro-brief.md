# Delegatus landing: brief for GPT-6 Pro

Status: a prompt to paste into ChatGPT with GPT-6 Pro selected. It asks for an
independent landing concept in the same shape as `concept-opus.md`, which it
deliberately does not show. A later lane merges the two.

## The requirement

Paraphrased from the operator's dictated request to the orchestrator seat on
2026-09-26 (the full paraphrase is at the top of `concept-opus.md`): research a
landing page for Delegatus, get one concept from GPT-6 Pro and a separate one
from Opus, then integrate both. If Codex cannot run GPT-6 Pro, prepare a prompt
the operator pastes into ChatGPT in the browser, or the seat sends through the
operator's logged-in browser.

## How to use it

Codex's model list offers gpt-6-astra, gpt-6-luna and gpt-6-sol and no 6 Pro
(as recorded in this lane's specification), so GPT-6 Pro runs in ChatGPT:

1. Open a new chat at <https://chatgpt.com/>, pick GPT-6 Pro.
2. Attach the seven README screenshots as images, if you can. GPT-6 Pro
   can also fetch them from the URLs in the prompt, but each SVG is 0.3–3.3 MB
   of DOM export, so PNG renders read faster. Any of these renders them:
   `rsvg-convert -w 1600 docs/media/readme/board.svg -o board.png` (one per
   file), or open the SVG in a browser and take a screenshot.
3. Paste everything between the two rules below as the message.
4. Save the answer as `docs/landing/concept-gpt6pro.md` for the integration
   lane.

---

You are a senior product designer and art director. Design the UX and the
structure of a landing page for an open-source developer tool called
**Delegatus**. Work from the facts below; where you need a fact that is not
here, visit the repository or say that you are assuming it. Do not invent
features.

## What Delegatus is

Delegatus is a local app (a web UI plus a background runtime on the user's
own machine) for handing software work to coding agents. The user tells one
agent, the project's **orchestrator**, what they want shipped, in plain
language ("take issues 12 and 14", "fix the flaky test in the scanner").
The orchestrator then does the rest:

- opens a **task** on the project's **board** (a kanban with Inbox,
  Assigned, Blocked, Done) for each piece of work;
- runs a **pipeline** for each task in its own git worktree and branch: up to
  eight agent stages such as Build, Review, Verify, each a separate agent with
  its own role, engine, model and effort. A stage ends with a verdict: pass
  moves on, fail goes back to the builder within a round budget, "needs
  decision" stops and asks the human. Reviewers are fresh agents each round,
  read-only, so a review reads the whole diff without the builder's context;
- can merge a pull request by itself once its reviews pass and CI is green
  (a per-project switch, off by default);
- files a **report** as each piece lands (a stage passed or failed, a review
  verdict, a blocked lane, a question), shown in a Reports log beside its
  chat, and can mirror reports to a Telegram group;
- asks the human only when a decision is theirs, through a **Needs you**
  counter on the board and a question in its chat.

Around that core:

- **Traceability.** Every agent conversation on the machine reads as a chat,
  whoever started it: Claude Code sessions and their subagents, Codex
  rollouts, GitHub Copilot sessions. Tool calls are cards (an edit as a diff,
  a command with its output). A global search (the `/` key) finds messages
  across every conversation and project.
- **Agents talk to each other across engines.** Pipeline stages run on Claude
  Code or Codex, often a Claude builder with a Codex reviewer. Agents reach
  the board, tasks, pipelines and each other's conversations through a
  bundled MCP server, and can message each other through it.
- **Multiple accounts.** Several Claude, Codex and Copilot accounts, each
  with its own login; the sidebar shows each account's five-hour and weekly
  usage windows and when they reset, and you switch the active account before
  a limit stops you.
- **Telegram, native.** Sign in with a Telegram account by QR code and agents
  get read access to the chats you grant through a `telegram` MCP connector;
  connect a bot token and agents post to the chats you allowlist.
- **Phone.** A dedicated phone layout (the board as swipeable tabs, cards that
  need you pinned first), reached over the user's own Tailscale network; push
  notifications when an agent asks a question.
- **Voice.** Dictation in the composer (local faster-whisper by default).
- **Activity.** A page with the time the user spent and the time their
  agents worked, per day and per project.
- Runs on Linux, macOS, and Windows through WSL 2. Listens on 127.0.0.1.
  Nothing is hosted; it uses the user's own Claude and Codex subscriptions.
- Interface languages: English and Ukrainian.

Facts for copy:

- Repository: <https://github.com/Latand/delegatus> (README is the
  documentation).
- npm package `delegatus-cli`, version 1.5.0; commands `delegatus` and the
  short alias `dlg`; MCP server command `delegatus-mcp`, registered under the
  key `viewer`.
- Needs Bun 1.4 or newer. Run once: `bunx delegatus-cli`. Install:
  `bun add -g delegatus-cli`. Serves <http://127.0.0.1:8898/>. A setup guide
  on first visit connects Claude Code or Codex, picks a project folder and
  creates its orchestrator.
- Register the MCP server: `claude mcp add viewer -s user -- delegatus-mcp`
  for Claude Code, `codex mcp add viewer -- delegatus-mcp` for Codex.
- README tagline: "Delegate everything."
- The name is Latin for "the one sent with a mandate" (a delegate).
- Formerly called Agent Log Viewer.

## Brand facts (already shipped)

- **Mascot / emblem**: an original character, a round red bird (`#E0392B`)
  with a cream belly (`#F7DCC6`), swept grey hair (`#7B6D68`) and bold
  dark-framed glasses, no beak. Flat SVG, drawn on a 64 grid. Files:
  <https://raw.githubusercontent.com/Latand/delegatus/main/public/brand/delegatus-mark.svg>,
  <https://raw.githubusercontent.com/Latand/delegatus/main/public/brand/delegatus-badge.svg>,
  <https://raw.githubusercontent.com/Latand/delegatus/main/public/brand/delegatus-lockup.svg>.
- App palette: dark surfaces `#111218` (canvas), `#191b23` (card), `#292c36`
  (border); light surfaces `#f4f1ec`, `#fffdfa`; a brand pair slate `#262a36`
  and cream `#fbebdd`; a violet accent for links, focus and running states;
  green for working, amber for "needs you".
- The wordmark is outlined from Adwaita Sans.
- The product UI is dark in all the screenshots below.

## Real screens you can use

All from a seeded demo project `harbor-api` with synthetic data. Use them as
the page's pictures; you may crop, layer and animate them.

1. `board.svg`: a project's board. Sidebar with projects, RAM, Claude and
   Codex usage bars; columns Inbox, Assigned, Blocked; task cards with their
   pipeline chips (Build → Review → Verify), "working" dots, a card stopped on
   a decision with Skip Build / Retry Build, and a gold **Needs you 1 · Next**
   pill in the header.
2. `orchestrator.svg`: the orchestrator unfolded over the board. Its chat
   (the user's one-line instruction, its answer) and, beside it, the
   **Reports** log with timestamped entries (status, completed, review
   verdict).
3. `pipeline.svg`: a pipeline opened from its task. The stage graph on top
   (Build on Claude Opus 5.5 → Review on Codex gpt-6-sol → Verify on Claude
   Sonnet, with a dashed fail edge from Review back to Build), and the
   builder's and the reviewer's live conversations side by side.
4. `conversation.svg`: a Claude Code conversation read as a chat: an edit
   shown as a diff, a test run with its output, the answer.
5. `accounts.svg`: the Claude accounts popover: two accounts, each with
   five-hour, weekly and per-model limit bars and reset times.
6. `phone-board.svg`: the phone board: status tabs, a card that needs a
   decision pinned first, the orchestrator bar, a "Tell the orchestrator…"
   composer.
7. `phone-conversation.svg`: a conversation on the phone with its test run
   expanded.

URLs: `https://raw.githubusercontent.com/Latand/delegatus/main/docs/media/readme/<name>.svg`.
There is no screenshot of the global search, the Activity page or the
Telegram panel yet; if your concept needs one, describe exactly what it
shows so it can be captured.

## What the landing must do

The owner's requirements:

1. Introduce Delegatus as an orchestrator you hand work to, which knows how to
   do it efficiently and well: with checks, fully autonomously, with reports.
2. Show full traceability (open any conversation, search across all of
   them), multiple accounts, agents talking to each other across Claude Code
   and Codex, and the native Telegram MCP.
3. Minimum text, maximum pictures. Three or four sections at most.
4. **Install through the visitor's own coding agent**: a box with tabs for
   Claude Code and Codex that copies an install prompt the visitor pastes into
   their agent, which then installs and starts Delegatus for them.
5. **A separate "legacy" install through Bun** for people who still use a
   terminal (`bunx delegatus-cli`). There, the Delegatus mascot playfully
   laughs at the visitor for still typing commands.
6. Minimal, beautiful, and free of the look of generated landing pages. Use
   real reference sites.
7. English and Ukrainian versions of all copy.

## Constraints

- Every claim must be true of version 1.5.0. No pricing, no teams, no cloud
  hosting, no testimonials, no invented numbers.
- The page is static and separate from the app.
- Accessibility basics: contrast of 4.5:1 for body text, keyboard-reachable
  copy buttons, and a `prefers-reduced-motion` version of every animation.
- Avoid the patterns that mark a page as generated: eyebrow labels above
  headings, section numbers, gradient text, rows of identical icon cards,
  hero metrics, glowing orbs and sparkles, fake window chrome, monospace used
  as decoration, a logo wall, cream paper with a terracotta accent, one
  identical fade-in on every block. If you use one anyway, say why this page
  needs it.
- Before naming a typeface, check it covers Cyrillic.

## What to deliver

One Markdown document with exactly these parts:

1. **Positioning in one line**, then the headline and sub-line in EN and UK.
2. **Section-by-section structure** (3–4 sections plus nav and footer). For
   each: the heading (EN/UK), the layout on desktop and on a 390 px phone,
   which real screen(s) it uses and how they are cropped or combined, what
   moves and when (durations, triggers, the reduced-motion version), and the
   captions (EN/UK, one line each).
3. **The install box**: the exact prompt text for the Claude Code tab and for
   the Codex tab, ready to copy, and how the box looks and behaves (what is
   visible, the copy feedback). The prompt must be safe for the visitor to
   read and must work with the commands above.
4. **The legacy Bun install and the joke**: the box, the mascot's action and
   its lines in EN and UK.
5. **The mascot**: how it is used across the page, which new poses are
   needed, and the rules for when it appears.
6. **Visual direction**: typefaces (with licence and Cyrillic coverage),
   colour roles with hex values, motion principles, how screenshots are
   framed.
7. **References**: 6–10 real sites you have looked at, each with its URL,
   what to take from it, and what to leave. Mark any you could not open.
8. **What to avoid** on this page.
9. **A table** mapping each of the owner's seven requirements to the part of
   your page that meets it.

Be concrete enough that a designer could build it without asking you a
question. Prefer a decision to a list of options; where you are unsure,
decide and say what you assumed.

---
