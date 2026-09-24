# Changelog

All notable changes to Delegatus are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
- **Delegatus is the product name.** The package is `delegatus-cli`
  ([#2038]).

[Unreleased]: https://github.com/example/delegatus/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/example/delegatus/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/example/delegatus/compare/v1.2.2...v1.3.0
[#1713]: https://github.com/example/delegatus/pull/1713
[#2038]: https://github.com/example/delegatus/pull/2038
[#2068]: https://github.com/example/delegatus/pull/2068
[#2073]: https://github.com/example/delegatus/pull/2073
[#2076]: https://github.com/example/delegatus/pull/2076
[#2079]: https://github.com/example/delegatus/pull/2079
[#2082]: https://github.com/example/delegatus/pull/2082
[#2083]: https://github.com/example/delegatus/pull/2083
[#2086]: https://github.com/example/delegatus/pull/2086
[#2089]: https://github.com/example/delegatus/pull/2089
[#2090]: https://github.com/example/delegatus/pull/2090
[#2095]: https://github.com/example/delegatus/pull/2095
[#2096]: https://github.com/example/delegatus/pull/2096
[#2099]: https://github.com/example/delegatus/pull/2099
[#2100]: https://github.com/example/delegatus/pull/2100
[#2101]: https://github.com/example/delegatus/pull/2101
[#2104]: https://github.com/example/delegatus/pull/2104
[#2107]: https://github.com/example/delegatus/pull/2107
[#2109]: https://github.com/example/delegatus/pull/2109
[#2112]: https://github.com/example/delegatus/pull/2112
[#2114]: https://github.com/example/delegatus/pull/2114
[#2116]: https://github.com/example/delegatus/pull/2116
[#2118]: https://github.com/example/delegatus/pull/2118
[#2120]: https://github.com/example/delegatus/pull/2120
[#2122]: https://github.com/example/delegatus/pull/2122
[#2125]: https://github.com/example/delegatus/pull/2125
