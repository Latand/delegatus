# Product Hunt launch kit

Status: ready to schedule. This file holds the listing copy, the gallery, the
maker's first comment, the launch-day schedule and prepared replies. The
gallery renders from the landing's own demo, so it shows the product as it is
on `main` the day it is rendered.

What Product Hunt is for us: a day of attention from people who try new tools,
a lasting backlink, and a shot at the quarterly Orbit Awards, which replaced
the Golden Kitty and plan a coding-agents category. It has no fundraising
feature. Investors notice products that keep growing after launch day, not the
launch itself.

## 1. The listing

| field | value |
| --- | --- |
| Name | Delegatus |
| Tagline (60 max) | **One orchestrator for your Claude Code and Codex agents** (54) |
| Links | `https://delegatus.org` (first), `https://github.com/Latand/delegatus` |
| Pricing | Free (open source) |
| Topics | Developer Tools, Artificial Intelligence, Open Source, GitHub, Productivity |
| Thumbnail | `gallery/thumbnail.png`, 240×240 |
| Gallery | the seven slides in section 3, in that order |
| Shoutouts | Claude Code, Codex, GitHub Copilot, Bun, Tailscale |

Other taglines, if the first reads wrong on the day:

- Hand your backlog to a team of AI coding agents (47)
- Delegate coding work. Agents build, review, report back (55)
- An AI dev team that builds, reviews and asks you last (53)

Description (kept under the older 260-character limit, 244):

> Tell one orchestrator agent what you want shipped. It opens tasks, runs
> Claude Code, Codex and Copilot agents to build each change, has a fresh agent
> review it, and asks you only when the call is yours. Open source, local, on
> your own accounts.

## 2. Maker's first comment

Post it the minute the launch goes live. First person, no marketing voice.
Refresh the two numbers from the install slide before posting (section 3).

> Hi Product Hunt!
>
> Delegatus started as a log viewer: I wanted to read what my Claude Code and
> Codex agents were doing without scrolling five terminals. Then I wanted them
> to review each other, and then I wanted to stop being the message bus
> between them ("review this", "fix what the reviewer found", "did the tests
> pass?").
>
> Now it is one conversation. You talk to an orchestrator agent
> about a project. It opens tasks on a board and runs each through a pipeline:
> a builder in its own git worktree, then a fresh, read-only reviewer, often on
> the other engine so Codex reviews what Claude wrote, then a verifier. A
> failed review goes back to the builder. You hear from it when a decision is
> actually yours: on the board, on your phone, or in Telegram.
>
> What I cared about:
>
> - It runs on your machine, through the Claude Code, Codex and Copilot CLIs
>   you already use. No cloud in between.
> - Every agent conversation opens as a chat and is searchable, including
>   sessions you started outside Delegatus.
> - Merging is your switch, and it is off by default.
>
> It is built with itself: 298 of the 311 pull requests merged into Delegatus
> in the last 30 days were co-authored by agents it ran.
>
> The live demo on delegatus.org is the real interface running on invented
> data, so you can click through it without installing anything. To run it:
> `bunx delegatus-cli`. It is free and MIT licensed.
>
> Two questions I would love answers to: what is the first task you would hand
> it, and what would it take for you to let it merge on its own?

## 3. Gallery

Render it from a checkout with full history (the install slide counts merged
pull requests from `git log`):

```sh
git fetch --unshallow origin main    # only if the clone is shallow
bun landing/site/build.ts
CHROME_BIN=/path/to/chrome LANDING_RENDER_DIR="$HOME/Pictures/delegatus-launch" \
  bun landing/site/capture.ts --gallery
```

The PNGs land in `$LANDING_RENDER_DIR/gallery/` at 2540×1520 (1270×760 at 2×),
which Product Hunt scales down. They are never committed: the publication gate
refuses rasters without provenance, and they are regenerated for every launch.

| # | file | shows | caption |
| --- | --- | --- | --- |
| 1 | `01-orchestrator.png` | the orchestrator docked beside the board, a task needing a decision | Delegate everything. |
| 2 | `02-pipeline.png` | Build → Review (Codex) → Verify with each stage's conversation | Build, review, verify. On its own. |
| 3 | `03-decision.png` | a stage stopped on a product decision | It stops only when the call is yours. |
| 4 | `04-conversation.png` | a builder's session: diff, test run, answer | Every agent session reads as a chat. |
| 5 | `05-accounts.png` | several Claude accounts with their windows | Your accounts. Your limits, in view. |
| 6 | `06-phone.png` | the phone board and a decision on the phone | Answer from your phone. |
| 7 | `07-install.png` | `bunx delegatus-cli` and the built-with-itself count | Runs on your machine. Uses your accounts. |

`thumbnail.png` is the 240×240 icon. `social-preview.png` (1280×640) goes to
the repository's Settings → Social preview.

Captions live in `GALLERY` in `landing/site/capture.ts`; change them there.

### Video (optional, recommended)

Product Hunt takes a YouTube link. Record the landing hero playing its script
(about 20 seconds), then a real install on a clean machine up to the first
orchestrator reply. Keep it under 60 seconds, no voice-over needed, captions
burned in. Record on an install with invented projects only: nothing from a
real board, account list or transcript may appear on screen.

## 4. Schedule

Launch on a Tuesday, Wednesday or Thursday. A launch goes live at 00:01
Pacific, which is 10:01 in Kyiv all year. Schedule it from the maker account
up to a month ahead; the account should be at least a few weeks old and have
some real activity, because votes from brand-new accounts are discounted.

| when | what |
| --- | --- |
| T−14 days | Maker profile complete (photo, headline, links). Comment genuinely on a few launches in Developer Tools. Schedule the launch. |
| T−10 | Repository ready: description, topics, website field set to delegatus.org, Discussions on, social preview uploaded. |
| T−7 | Write the list of people to tell on the day: users, workshop attendees, colleagues. The message asks them to look and leave feedback, never to upvote. |
| T−3 | Clean-machine install on macOS and Linux, from `bunx delegatus-cli` to the first orchestrator reply. Fix whatever stops it. |
| T−1 | Cut the release. Render the gallery (fresh numbers). Upload the assets. Set the Product Hunt link in `landing/site/launch.js`, deploy the landing. |
| 10:01 Kyiv | First comment. Tell your list. Post on X and in the Telegram channel with the link (see `channels.md`). |
| all day | Answer every comment within 15 minutes. Turn real bug reports into GitHub issues and reply with the link. |
| T+1 | Thank-you post. Badge on the landing and README if it placed. Write down what people asked; it is the next roadmap. |

Show HN goes on a different day, not the same one, so each gets full
attention (see `channels.md`).

## 5. Rules we keep

- Never ask anyone to upvote, and never share a direct voting link in groups.
  Asking people to try it and comment is fine. Vote rings get a launch
  penalized.
- Every number we post comes from a command someone can re-run (see
  `press-kit.md`). No invented usage figures.
- Screens and video show invented data only. The landing demo world
  (`harbor-api`) exists for exactly this.

## 6. Prepared replies

Short, honest, in our own voice. Adjust to the actual question.

**How is this different from running agents in parallel in the Codex app or
Claude Code?**
Those give you parallel sessions that you manage. Delegatus puts an agent in
that seat: you tell the orchestrator the outcome, it opens tasks, starts the
builders and reviewers, routes failed reviews back, and reports. You manage
outcomes and decisions instead of sessions. It also mixes engines, so a Codex
reviewer can check Claude's work and agents on different engines can message
each other.

**Does my code go anywhere?**
No. Delegatus listens on 127.0.0.1. Agents run through the official CLIs on
your machine with your own logins, exactly as if you had started them in a
terminal. Phone access publishes it only inside your Tailscale network, never
to the public internet.

**What does it cost to run?**
Delegatus is free. The agents use the Claude, ChatGPT or Copilot plans you
already have, and count against their limits the same way.

**Can it merge or deploy without me?**
Merging only if you turn on "Merge when the review passes", per project, and
then only once every check is green; it never resolves a conflict. No pipeline
stage can take the deployer role, so deploys stay yours.

**Why several accounts per engine?**
Many of us have a work and a personal account, or a team seat and a personal
plan. Delegatus shows each account's usage windows and lets you choose which
one an agent runs on. Use them within each provider's terms.

**Windows?**
Through WSL 2. macOS and Linux run natively.

**Which models?**
Whatever your CLIs offer, per stage: for example a strong model to build and
a different engine to review. Anthropic-compatible providers can be added as
Claude accounts.

**Is there a paid version?**
Delegatus is free and MIT licensed, and the local product stays that way. If
you run it for a team and want help setting it up, write to us through GitHub
Discussions.

**Who is behind it?**
An independent developer, plus the agents in the numbers above.
