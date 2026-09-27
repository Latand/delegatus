# Press kit

Status: current as of 1.5.0. Everything a writer, a list maintainer or a
launch page needs, in one place. Each number has the command that produces
it; re-run them before quoting.

## One line

Delegatus is an open-source orchestrator for AI coding agents: tell one agent
what you want shipped, and it runs Claude Code, Codex and Copilot agents to
build, review and verify the work.

## Fifty words

Delegatus hands software work to AI coding agents and brings it back reviewed.
You talk to an orchestrator agent; it opens tasks, runs each through a
pipeline of builder, independent reviewer and verifier on Claude Code, Codex or
Copilot, and asks you only for real decisions. It runs locally on your own
agent accounts. MIT.

## A hundred words

Delegatus is a local orchestrator for AI coding agents. Instead of juggling
parallel agent sessions, you tell one orchestrator agent the outcome you want.
It opens a task on a board and runs a pipeline for it: a builder in its own git
worktree, then a reviewer that starts fresh with read-only access, often on a
different engine, then a verifier. Failed reviews go back to the builder;
decisions come to you on the board, on your phone or in Telegram. Every agent
conversation on the machine opens as a searchable chat. Delegatus drives the
official Claude Code, Codex and Copilot CLIs with your own logins. It is free
and MIT licensed.

## Facts

| fact | value | how to check |
| --- | --- | --- |
| License | MIT | `LICENSE` |
| Current release | 1.5.0 (2026-09-25) | `CHANGELOG.md` |
| Install | `bunx delegatus-cli` | README, Quick start |
| Engines | Claude Code, Codex, GitHub Copilot (single agents) | README |
| Platforms | macOS, Linux; Windows through WSL 2 | README |
| Pull requests merged since the repository opened (2026-07-03) | 660 on 2026-09-27 | `git log --first-parent --format=%s origin/main \| grep -cE '\(#[0-9]+\)$'` |
| Merged in the last 30 days, and how many with an agent co-author | 311, of which 298 | printed by `bun landing/site/capture.ts --gallery` |
| Languages of the interface | English, Ukrainian | `src/lib/i18n` |

## Assets

| asset | file |
| --- | --- |
| Mark (square) | `public/brand/delegatus-mark.svg` |
| Mark on slate (app icon) | `public/brand/delegatus-touch-icon.svg` |
| Lockup for light backgrounds | `public/brand/delegatus-lockup.svg` |
| Lockup for dark backgrounds | `public/brand/delegatus-lockup-on-dark.svg` |
| Character badge | `public/brand/delegatus-badge.svg` |
| Social card (1280×640) | `public/brand/delegatus-social-card.svg` |
| Screenshots with captions | render with `--gallery`, see `product-hunt.md` §3 |
| Live, clickable demo | https://delegatus.org |

The name is Latin for "delegated". It is a brand and is written
Delegatus in every language, including Ukrainian. The palette and the
emblem's rules are in `docs/design/delegatus-brand.md`.

## Links

- Website and live demo: https://delegatus.org
- Source: https://github.com/Latand/delegatus
- npm: https://www.npmjs.com/package/delegatus-cli
