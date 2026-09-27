# Launch

Everything for putting Delegatus in front of people: the copy, the pictures
and the order to do it in.

| file | what it holds |
| --- | --- |
| `product-hunt.md` | the listing, the maker's first comment, the gallery, the schedule, prepared replies |
| `channels.md` | Show HN, Reddit, X, LinkedIn, curated lists, DOU and Telegram, with the order of the week |
| `press-kit.md` | one-, fifty- and hundred-word descriptions, facts with the commands behind them, brand assets |

The gallery is rendered, never committed:
`bun landing/site/capture.ts --gallery` (see `product-hunt.md` §3).

On launch day, the landing shows a Product Hunt banner once
`landing/site/launch.js` has the launch's URL; empty, it shows nothing.

## Before the first launch

Settings that live outside the repository and must be set by hand:

- [ ] Repository About: description, website `https://delegatus.org`, topics
      (`ai-agents`, `claude-code`, `codex`, `github-copilot`, `orchestrator`,
      `mcp`, `developer-tools`, `local-first`).
- [ ] Repository Settings → Social preview: `social-preview.png` from the
      gallery render.
- [ ] Repository Settings → Features: Discussions on, with a "Show and tell"
      and a "Teams" category, so people who want help running it for a team
      have somewhere to ask.
- [ ] Product Hunt maker account with a real profile, a few weeks old.
- [ ] Hacker News account with some history.
- [ ] A clean-machine install on macOS and on Linux, timed from
      `bunx delegatus-cli` to the orchestrator's first reply.
- [ ] Privacy-friendly analytics on delegatus.org (optional), so the launch
      traffic and the install-prompt copies can be counted.

## Rules for every post

- Invented data only on screen. The landing's demo world exists for this.
- No account handles, emails or home paths, as everywhere in this repository.
- Numbers from a command anyone can re-run, never estimates presented as
  facts.
- Never ask for upvotes. Ask people to try it and say what broke.
