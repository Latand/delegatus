# Launch channels and copy

Status: drafts ready to post. For developer tools, Show HN, Reddit and the
curated lists usually bring more lasting users than Product Hunt, so each one
gets its own day and its own voice. Numbers come from `press-kit.md`; refresh
them before posting.

Order of the launch week:

| day | channel |
| --- | --- |
| Tue | Product Hunt (`product-hunt.md`), X thread, Telegram channel, LinkedIn |
| Thu | Show HN |
| next Mon | r/ClaudeAI, then one subreddit a day |
| any day | pull request to awesome lists; DOU submission |

## Show HN

Post from an account with some history: since March 2026 Hacker News shows
Show HN posts from new or low-karma accounts in a limited view, because of a
flood of agent-built submissions. It must be something people can try, which
the live demo and `bunx delegatus-cli` both are. Plain language; no
superlatives; no friends in the comments.

Title (80 max):

> Show HN: Delegatus – an orchestrator agent for Claude Code and Codex (68)

Text:

> Delegatus runs on your machine and gives one agent the job of managing the
> others. You tell the orchestrator what you want done in a project; it opens a
> task on a board and starts a pipeline for it: a builder in its own git
> worktree, then a reviewer that starts fresh with read-only access, then a
> verifier. A failed review goes back to the builder until a round budget runs
> out. Stages can run on different engines, so Codex can review what Claude
> Code wrote. When a stage needs a product decision it stops and asks.
>
> It drives the official CLIs (Claude Code, Codex, Copilot) with your own
> logins, so it adds no API bill and no server in between. Every transcript on
> the machine opens as a chat, including sessions you started by hand, and one
> search covers all of them.
>
> Some things that turned out harder than expected: keeping agents alive
> across our own releases (a separate runtime host owns the processes and
> hands them over between versions), grouping sessions from deleted worktrees
> under their parent repo, and making a reviewer genuinely independent of the
> builder's context.
>
> Most of Delegatus is now written by agents running in it: 298 of the 311
> pull requests merged in the last 30 days carry an agent co-author. The
> repository and its review history are public.
>
> Demo (the real interface on invented data): https://delegatus.org
> Code (MIT): https://github.com/Latand/delegatus
>
> I would like to hear where it breaks for you, and what you would need before
> letting it merge on its own.

## Reddit

Read each subreddit's sidebar on the day; rules change. Disclose that you
built it. Answer comments for the first few hours. One subreddit per day, each
post written for that community rather than cross-posted.

**r/ClaudeAI** (flair: Built with Claude). Lead with how it uses Claude Code:

> Title: I let Claude Code and Codex agents build my orchestrator. 298 of the
> last 311 merged PRs have an agent co-author.
>
> Body: what Delegatus does in three sentences; the Build (Claude) → Review
> (Codex, read-only, fresh context) → Verify loop and why a cold reviewer
> catches what a builder's own review misses; one concrete example of a review
> that sent work back; the link to the demo and the repo; a question about how
> others run review for agent-written code.

**r/ChatGPTCoding**: in the weekly self-promotion thread only. Lead with Codex
as reviewer and cross-engine messaging.

**r/codex**, **r/GithubCopilot**: check the rules first. Lead with the engine
that subreddit cares about and the per-stage engine choice.

**r/selfhosted**: lead with local-first: binds to 127.0.0.1, phone access only
inside a tailnet, Docker compose available, no telemetry of its own.

## X thread

1. Delegatus is out: one orchestrator agent that runs your Claude Code, Codex
   and Copilot agents. You say what you want shipped; it plans, builds,
   reviews and asks you only when the call is yours. Free, MIT, local.
   [gallery 1]
2. Every task runs as a pipeline in its own worktree: a builder, then a fresh
   read-only reviewer, often on the other engine. Codex reviews what Claude
   wrote. A failed review goes back to the builder. [gallery 2]
3. It stops only for decisions that are yours, and they wait on the card with
   the finding and the ways forward. Merging on a passed review is a switch,
   off by default. [gallery 3]
4. Every agent session on your machine reads as a chat, including the ones
   you started by hand. Press / to search everything any agent wrote.
   [gallery 4]
5. Your board on your phone, inside your tailnet. A push when an agent asks
   you something. Reports to Telegram. [gallery 6]
6. It is built with itself: 298 of the 311 PRs merged in the last 30 days
   were co-authored by agents it ran. Try the live demo, no install:
   delegatus.org · `bunx delegatus-cli`

## LinkedIn

> For three months I have managed a software project mostly by talking to one
> agent. Delegatus, the tool I built for it, is now open source.
>
> You tell an orchestrator agent the outcome. It opens tasks, runs Claude
> Code, Codex and Copilot agents to build and independently review each
> change, and brings you only the decisions that are yours. 298 of the 311
> pull requests merged into it in the last 30 days were co-authored by those
> agents.
>
> If your team is working out how to put coding agents to work with review you
> can trust, I would be glad to compare notes. Demo: delegatus.org

## Curated lists

Open a pull request adding Delegatus to
`github.com/andyrewlee/awesome-agent-orchestrators`, following that list's
format, and to any list of Claude Code or MCP tools that accepts entries. One
line each: "Delegatus — an orchestrator agent that runs Claude Code, Codex and
Copilot pipelines with independent review, local-first, MIT."

## Ukrainian channels

**DOU.** Submit to the «DOU Проектор» column through the editors, and offer a
longer article. Suggested article: «Як я делегую розробку агентам: 311 злитих
PR за місяць, з них 298 — у співавторстві з агентами». Outline:

1. Звідки взялося: переглядач логів агентів, який виріс в оркестратор.
2. Як працює конвеєр: builder → свіжий read-only рев'юер на іншому рушії →
   verifier; бюджет раундів; рішення, які лишаються за людиною.
3. Що пішло не так і чого навчило: агенти, що вмирали на релізах, воркдерева,
   що губили групування, тести, що зачіпали живий стан.
4. Скільки це коштує: ті самі підписки, без API-рахунку.
5. Як спробувати: демо на delegatus.org, `bunx delegatus-cli`.

**Telegram channel post:**

> Delegatus — відкритий оркестратор для агентів Claude Code, Codex і Copilot.
> Кажете одному агенту, що треба зробити, а він відкриває задачі, запускає
> білдерів і незалежних рев'юерів і питає вас лише тоді, коли рішення ваше.
> Працює локально на ваших акаунтах, MIT.
>
> Сьогодні ми на Product Hunt, заходьте подивитися й лишити відгук:
> [посилання на запуск]
> Живе демо без встановлення: delegatus.org
