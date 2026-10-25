# Claude Code cloud: a second cloud runtime for pipeline stages and checks

Status: proposed. First written 2026-10-24; revised 2026-10-25 with the
operator's answers and their 06:22 UTC correction, then again the same day for
run recovery, follow-up receipts and the launch contract when L1 is unusable,
and once more for binding the result to the last part, the first readiness
check and candidates whose prompt event is not visible yet.
Design only; no product code changes here.

Made from `main` at `e28d793c` (2026-10-25). That `main` contains PR #3302
(merged as `0c7f7a89`) and PR #3330 (merged as `16f00de7`). The first revision
read `main` at `3736d5e4` with both PRs still open. The unapplied Cloud result
73 diff (22,821 bytes, SHA-256 prefix `ff7f5def95ad5e32`) still applies
cleanly to `e28d793c`. Anthropic documentation was read 2026-10-24 between
14:29 and 14:36 UTC; the pages this revision depends on were fetched again
2026-10-25 at 06:24 UTC.

## Originating requirement

Pinned task specification, verbatim. It carries the operator's voice message of
2026-10-24 ~11:05 UTC (chat).

> Operator requirement, 2026-10-24 ~11:05Z, chat (voice, verbatim): «Менять, а
> менять будет где? Там де ти задачу. Вот. Code, code, cloud. Даже. Тоже хотел.
> So cloud code. Cloud code. C-L-A-U-D. И чтобы. Там выполнялось всё. То, что
> можно выполнять для, ну, для кода. И, соответственно, чтобы парсить. Что можно
> для. И встраивать пайплайны, и всё такое. То есть это кодекс cloud, можно,
> можно потом будет. Встроить cloud code cloud. Или даже вместе. Но это тоже
> надо.»
>
> Outcome of this lane: a design document, docs/design/claude-code-cloud.md,
> that lets the next lanes build Claude Code cloud execution (Anthropic-hosted
> Claude Code sessions) as a second cloud runtime beside Codex Cloud: pipeline
> build/review/verify stages and heavy checks can run there, alone or mixed with
> Codex Cloud, and show in pipelines and on the board like local stages.

The stage brief adds the operator's model of how Cloud works, 2026-10-24
~11:10 UTC, chat (voice, verbatim):

> «Понял, как должен Cloud работать. Cloud должен давать. Возможность, как
> агента, как. Мы ставим, мы ставим на стадию review. Review, review. Cloud
> должен. Cloud должен эту стадию выполнять, как часть. То есть. То есть
> локально. Что локально, что. Регулировать. Регулировать. Back on the locale.
> Это должно регулироваться с fallback'ом на locale.»

Read with the brief: cloud is a runtime chosen per pipeline stage (review,
verify, build, fix, checks), set on the stage like engine and model. The stage
runs in the cloud as a normal part of the pipeline. When the cloud cannot run it
(unavailable, or its own limits, retried and confirmed), the same stage runs
locally. Claude Code cloud is a second provider of exactly that runtime, beside
Codex Cloud, with the same fallback.

## Operator decisions

> «Апі ключ поки не юзавємо! Лише підписку»

Operator, 2026-10-25 ~06:20 UTC, verbatim comment on the decision form «Claude
Code у хмарі: дозволи для першої проби» ("No API key for now! Subscription
only."). The five answers on the same form, as relayed to this stage:

1. **S0 may run:** about six short cloud sessions on one Claude account.
2. **Repository access is read-only:** a read-only token, or the GitHub App
   without write access. The probe must prove that a push and a comment are both
   refused.
3. **Anthropic's cloud is trusted like Codex Cloud**, with model training turned
   off on both Claude accounts.
4. **If S0 shows that a session's result cannot be read whole without GitHub**,
   Claude cloud runs only review and verification stages.
5. **Defaults:** UI review and frontend stages go to Claude cloud by default.
   Other stages choose per stage. Checks keep Codex Cloud as their default.

Correction by the operator, 2026-10-25 ~06:22 UTC, as relayed to this stage:
Claude Code cloud tasks run on the subscription login, which is Claude's
default mode. They use an API key only when one is explicitly selected as the
default, and an API-key path was never supported here. This design therefore
has subscription-authenticated cloud sessions only. Every call authenticates
with the claude.ai login the account already holds. Stages launch through the
scheduled-task run that the CLI's own `/schedule run` makes (L1). `claude
--cloud` (formerly `--remote`) from the logged-in CLI (L3) runs on the same
login and serves only S0, to open probe sessions and for U9 (1.3, 3).

Decisions of 2026-10-24 that still stand, recorded for Codex Cloud in
`docs/design/cloud-checks.md`: the cloud is trusted and may receive source
history and the committed privacy fingerprint catalog. The only privacy
boundary is the push to GitHub, which still requires the privacy gate. Cloud
or local is an option settable from the UI, over MCP and from the voice
companion. Use the parallelism the cloud's own limits allow. When the cloud is
unavailable or its own limits are exhausted (account limits excluded), retry,
confirm, then run locally once. A run cut by a cloud time limit falls back
locally. The operator asked for "exactly that per-stage runtime" for Claude,
so the same rules apply to Anthropic's cloud.

## Recommendation

Add Claude Code cloud as a provider behind the cloud-stage interface PR #3302
put on `main`. First converge the stage path onto that interface and give
Codex cloud stages the shared input composer, so the second provider plugs into
one seam.

On Anthropic's side, a session starts as a run of a scheduled task (formerly
"routine") that the operator creates once per account on claude.ai: this
repository, a cloud environment, a model and no connectors.
Delegatus starts each run with the call the installed CLI makes for `/schedule
run`, `POST /v1/code/triggers/{id}/run`, authenticated with the account's
subscription login. The assignment then arrives through the documented
follow-up command `claude -p --cloud <session-id>`. Anthropic documents no API
that reads a hosted session's result. The installed CLI reads one,
`GET /v1/code/sessions/{id}/events`. Both HTTP calls are in the same risk class
as the Codex desktop protocol the operator already accepted for Codex Cloud.

Neither call has an idempotency key, so each effect is bound to its attempt by
evidence read back from the session itself. A run counts as the attempt's own
only when its answer names it, or when its own events carry the attempt's
nonce. Each follow-up part counts as queued only when the CLI reported it
queued, or when the events show it. A result counts only when the events show
the last part's own user event, then a message carrying that part's random
receipt token, then the end of that turn; an idle session showing an older
verdict settles nothing. An outcome that no evidence settles stays unknown:
Delegatus never adopts another session for it and never sends the same run call
or part a second time. If S0 shows that a run or its result cannot be bound
this way, the Claude provider stays not ready and stages run on this machine.

The session clones the published lane branch through a GitHub connection that
can read and cannot write. Every session proves that before it receives its
assignment. The result returns to this machine as a checksummed diff and a
verdict. Delegatus applies the diff and publishes it through the normal
privacy-gated publication. If S0 shows that a result cannot be read back whole,
Claude cloud stays with review and verify stages (decision 4).

The observation spike S0 (six sessions on one account) must confirm the launch
call, the read channel and the write refusal before any product code depends on
them.

Cloud execution here saves this machine's CPU and memory. It does not save
quota: a Claude cloud session draws the same subscription usage as a local
Claude stage, and Anthropic says so itself.

## 1. What Anthropic documents

### 1.1 Sources

Each page was fetched as raw Markdown into stage scratch. No page carries a
publication date: the served `Last-Modified` equals the fetch time. On
2026-10-25 the pages this revision cites were fetched again. D1 and D3 changed
in size and were read whole again. D2 and D12 changed and their cited sections
were read again. The others had the same byte count on both days.

| # | URL | Read | Bytes | What it settles here |
| --- | --- | --- | --- | --- |
| D1 | https://code.claude.com/docs/en/claude-code-on-the-web.md | 10-24, 10-25 | 46,572 | What a cloud session is; `--cloud`, follow-ups, slash commands in sessions, bundles, errors, limits |
| D2 | https://code.claude.com/docs/en/cloud-environments.md | 10-24, 10-25 | 66,332 | VM, tools, network levels and allowlist, GitHub proxy and built-in GitHub tools, setup scripts, time limits |
| D3 | https://code.claude.com/docs/en/routines.md | 10-24, 10-25 | 49,929 | Scheduled tasks (renamed from routines): Run now, `/schedule run`, triggers, connectors, hourly caps |
| D4 | https://platform.claude.com/docs/en/api/claude-code/routines-fire.md | 10-24, 10-25 | 13,774 | The per-task HTTP trigger, which this design has no use for (1.3) |
| D5 | https://code.claude.com/docs/en/headless.md | 10-24, 10-25 | 37,648 | What `-p` refuses, including `--cloud` with a task description |
| D6 | https://code.claude.com/docs/en/cli-reference.md | 10-24, 10-25 | 51,769 | `--cloud`, `--environment`, `--teleport`, `--bg`, `ultrareview` |
| D7 | https://code.claude.com/docs/en/self-hosted-environments-testing.md | 10-24, 10-25 | 16,786 | Scripted dispatch and read-back, OAuth scope and its 30-day cap |
| D8 | https://code.claude.com/docs/en/self-hosted-environments.md | 10-24 | 21,029 | Self-hosted availability (Team and Enterprise beta) |
| D9 | https://code.claude.com/docs/en/cross-session-messaging.md | 10-24 | 36,283 | A cloud session cannot answer another machine |
| D10 | https://code.claude.com/docs/en/authentication.md | 10-24, 10-25 | 34,343 | Credential storage, `CLAUDE_CONFIG_DIR`, subscription use in cloud |
| D11 | https://code.claude.com/docs/en/data-usage.md | 10-24, 10-25 | 18,789 | Training choice, retention, where the setting lives |
| D12 | https://code.claude.com/docs/en/web-quickstart.md | 10-24, 10-25 | 25,621 | GitHub connection: App authorization, skipping its install, `/web-setup` |
| D13 | https://code.claude.com/docs/en/ultrareview.md | 10-24 | 20,120 | Cloud review: billing and output format |
| D14 | https://code.claude.com/docs/en/feature-availability.md | 10-24, 10-25 | 25,072 | Plans that have cloud sessions and scheduled tasks |
| D15 | https://code.claude.com/docs/en/github-actions.md | 10-24 | 29,711 | Subscription token for GitHub Actions |

Index used to find them: https://code.claude.com/docs/llms.txt (63,682 bytes on
both days).

### 1.2 What a cloud session is

D1: "A cloud session is a Claude Code session that runs on cloud infrastructure
instead of on your machine. By default it runs on infrastructure Anthropic
manages … It counts toward your plan's usage limits alongside the rest of your
Claude and Claude Code usage, and there's no separate charge for the cloud VM."
It is available on Pro, Max and Team plans, and on Enterprise with premium seats
(D1, D14).

D2: each session gets "a fresh virtual machine (VM) running Ubuntu 24.04 on
x86_64 … with your repository cloned and common toolchains pre-installed", with
"approximate resource ceilings that may change over time: 4 vCPUs, 16 GB of RAM,
30 GB of disk". "The VM may stop tasks that need significantly more memory."

D12: "Cloud sessions don't offer Manual or Bypass permissions." D3: a run of a
scheduled task "begins in auto mode unless auto mode is unavailable".

### 1.3 Starting a session: what a program can do

| Surface | What the documentation says | Usable here |
| --- | --- | --- |
| `claude --cloud "<task>"` | Creates a session for the current repository and clones its GitHub remote at the current branch. From "a github.com repository that the Claude GitHub App isn't installed on, Claude Code bundles your local repository … This applies even if you connected GitHub with `/web-setup`" (D1) | Interactively, from the logged-in CLI: launch L3, used only by S0 (3). With `-p` it is refused (D5): "Claude Code rejects `--bg`, and rejects `--cloud` with a task description, with an error naming the conflict" |
| `claude -p "<message>" --cloud <session-id> --output-format json` | "The CLI queues the message into the session and exits without waiting for a reply." The message may come on stdin. Prints `{ok, session_id, url}`, or `{ok: false, session_id, error}`; configuration errors go to stderr without JSON; `stream-json` is not supported (D1) | Yes, for an existing session, on the subscription login |
| Scheduled task **Run now**, and `/schedule run` in the CLI | "Click **Run now** to start a run immediately without waiting for the next scheduled time." "Run `/schedule list` … or `/schedule run` to start one immediately." `/schedule` "requires a claude.ai subscription login." Text supplied with Run now arrives wrapped as untrusted, like fire text (D3) | The feature is documented; its HTTP call is not. The installed CLI makes it as `POST /v1/code/triggers/{trigger_id}/run` with the account's login (1.11). **Chosen** |
| `claude -p … --environment ccpool_…` | Creates a session and exits (D7) | No: self-hosted environments only, "public beta on Team and Enterprise plans" (D8) |
| Web, mobile, desktop | Interactive (D1) | No |

D3 and D4 also document a per-task HTTP trigger with a token of its own. This
design has no use for it: the run call in the table starts the same run on the
login.

What a scheduled task fixes in advance (D3): its repositories, its cloud
environment, its connectors and its model ("Select a model in the prompt input's
model selector. Claude uses it on every run."). "When a trigger fires, the
session receives the saved prompt as its assignment and carries it out", and
that prompt "can't act as approval or consent for actions during the run".
"Claude starts from the repository's default branch unless your prompt
specifies otherwise." "Claude pushes its work to a branch prefixed with
`claude/` unless your prompt directs it to push to another branch."

Connectors (D3): "All of your connected MCP connectors are included by default.
Remove any the task doesn't need: Claude can use an included connector during a
run, including writes."

State that stops runs (D3): "Paused tasks keep their configuration but don't
run until you turn them back on." "If your GitHub connection is missing or expired when a run is due, the
scheduled task skips runs until you reconnect, for up to 72 hours … After 72
hours without a connection, the task turns off."

In cloud sessions (D1): "`/model`, `/effort`, `/color`, and `/rename`: pass the
value as an argument, for example `/model sonnet`". "`/fast`: toggles fast mode
for the session" (v2.1.271 or later in the session).

### 1.4 Reading a session: what a program can do

- For Anthropic-hosted sessions Anthropic documents no read API. The documented
  readers are the web transcript and `claude --teleport <id>`. Teleport needs
  "the branch from the cloud session must have been pushed to the remote" and a
  clean local tree (D1), which a read-only connection rules out.
- D3: `/schedule` "lists the task's recent runs with their status … It also
  reads a run's log to explain what happened, including tool errors, permission
  denials, and the final result. Requires Claude Code v2.1.227 or later." The
  feature is documented; its HTTP calls are not (1.11).
- D3: run outcomes **Succeeded**, **Failed** and **Cancelled** "say how the
  session ended, not whether Claude completed the work your prompt describes".
  Archiving a run's session turns it to **Cancelled**.
- D9: "A cloud session … can't use `SendMessage` to answer a message from
  another machine … Read the cloud session's response in its transcript at
  claude.ai/code."
- The documented scripted read-back exists only for self-hosted environments
  (D7).

### 1.5 Authentication

- D7: "Both `claude -p ... --environment` and `claude -p ... --cloud`
  authenticate with a claude.ai OAuth token". The cloud-control scope `user:sessions:claude_code` "is capped
  server-side at 30 days". A long-lived host re-runs `claude auth login` every
  30 days.
- D10: on Linux the login is `~/.claude/.credentials.json`, mode 0600, or the
  same file under `CLAUDE_CONFIG_DIR` when that is set. "Cloud sessions always
  use your subscription credentials."
- D1: `--cloud` is unavailable with Bedrock, Vertex or another third-party
  provider.

Every call in this design uses that login and nothing else.

### 1.6 Repository and environment

- GitHub connection (D1, D12). "Cloud sessions require a connected GitHub
  account." Two methods:

  | Method | Repositories sessions can reach (D1) |
  | --- | --- |
  | Claude GitHub App, authorized during web onboarding | "Any public repository, and private repositories that the Claude GitHub App is installed on" |
  | `/web-setup`, which "reads the token that `gh auth token` prints … and sends the token to Anthropic" | "Any repository your `gh` token can access" |

  Onboarding may prompt to install the App; "If … you'd rather do it later,
  click **Skip**" (D12). This repository is public.
- GitHub proxy (D1, D2): credentials "never enter a session's VM" (D1); the
  proxy attaches them server-side. It "rejects branch deletions and pushes of
  anything other than a branch … It doesn't limit which branches a push can
  update". It serves API requests only "for the repositories attached to the
  session" and rejects GraphQL with a 403, so `gh pr` and `gh issue` fail.
- Built-in GitHub tools (D2): sessions "read issues, list pull requests, fetch
  diffs, and post comments without any setup. These tools authenticate through
  the GitHub proxy using whichever method you configured". So a comment is
  refused exactly when the connected credential cannot comment.
- What GitHub itself does with each credential is outside Anthropic's
  documentation. Inferred: a GitHub App's user token reaches a repository for
  writing only where the App is installed, and a fine-grained token only with
  the permissions it was given. The U5 probe decides, and this inference does
  not.
- Bundles (D1): under 100 MB, history across all branches plus uncommitted
  changes to tracked files; untracked files left out. Larger falls back to the
  current branch, then to "a single squashed snapshot of the working tree".
- Scheduled tasks (D3): "Each repository you add is cloned on every run."
- What reaches the session (D2): the repository's `CLAUDE.md`,
  `.claude/settings.json` hooks (single-repository sessions), `.mcp.json`,
  `.claude/rules/`, `.claude/skills/`, `.claude/agents/` and
  `.claude/commands/`. User-level `~/.claude` and plugins do not.
- Setup scripts (D2) run as root before Claude Code starts. The filesystem is
  cached only when the script finishes in "roughly five minutes". The cache
  rebuilds when the script or network hosts change and after about seven days.
  Inside the VM, `CLAUDE_CODE_REMOTE` is `true`.
- D2: "Commits that Claude creates in a cloud session include a `Claude-Session:
  <url>` git trailer."

### 1.7 Limits

- Usage: scheduled tasks "draw down subscription usage the same way interactive
  sessions do"; cloud sessions "share rate limits with all other Claude and
  Claude Code usage within your account" (D1, D3). Over the subscription limit,
  without usage credits, "additional runs are rejected until your usage window
  resets" (D3).
- Starts (D3), "None of these hourly limits has overage":

  | Action | Limit | Counted for |
  | --- | --- | --- |
  | Run now, API fires, setting a one-off task to run again | 30 per hour | Each task, one count shared |
  | Run now, setting a one-off task to run again | 100 per hour | The account |
  | API fires | 100 per hour | The account, separately from Run now |
  | Scheduled runs | 100 per hour | The account |

- Concurrency: D3 lists the warning "The last run didn't start because your
  organization had reached its limit on cloud sessions running at once." The
  number for an individual Max account is not documented (U13).
- Time (D2): a foreground command gets 2 minutes by default and up to 10. A
  command that times out moves to the background and is stopped "up to 30 more
  minutes" later. SessionStart hooks get 600 seconds. "After a few minutes
  without activity, a session's VM pauses with its files saved." After a
  reclaim, D1 restores conversation history; "background work that was still
  running or pending" is not restored.
- Size: bundles under 100 MB (D1). Follow-up message size: not documented (U4).

### 1.8 Tools and network

- Installed (D2): Python 3, Node 20/21/22 with npm, yarn, pnpm and bun, Java 21,
  Go, Rust, GCC/Clang, Docker, PostgreSQL 16, Redis 7, git, gh, jq, yq, ripgrep,
  tmux and chromedriver. Bun "has known proxy compatibility issues for package
  fetching". Chromium is not listed.
- Network levels (D2): None, Trusted (the default allowlist), Full, and Custom.
  The Trusted list includes `storage.googleapis.com`, which serves Chrome for
  Testing downloads (inferred from Google's download URLs; U6 confirms). GitHub
  (through its proxy), MCP connectors and the Anthropic API stay reachable at
  every level.

### 1.9 Data

D11: "Anthropic stores the session transcript so you can return to the session
later." Consumer accounts keep data "5-year retention" when they allow data use
for model improvement and "30-day retention" when they do not. "Privacy settings
can be changed at any time at claude.ai/settings/data-privacy-controls."
"Deleting a session permanently removes the session's event data."

### 1.10 Documented alternatives, and why they do not fit

| Alternative | What it is (source) | Why it is not the runtime here |
| --- | --- | --- |
| Self-hosted environments | Sessions on our own runners, with a scripted dispatch and read-back recipe (D7, D8) | Team and Enterprise only, and the compute would be ours again |
| GitHub Actions | Claude Code on GitHub's runners with a `claude setup-token` token (D15) | Inputs and outputs travel through GitHub, and this repository is public |
| Ultrareview | A cloud multi-agent review returning `bugs.json` (D13) | "Bills against usage credits rather than your plan's included usage"; the stage verdict contract cannot read `bugs.json` |
| Remote Control | Steers a session that runs on this machine (D1) | Saves no local compute |

### 1.11 What I ran on this machine

Read-only, on both days. Nothing created a cloud session, ran a task, called a
claude.ai API or used a credential outside its own file.

| When | Command | Observed |
| --- | --- | --- |
| 10-24 | `claude --version`, `claude --help` | `2.1.302 (Claude Code)`. Flags `--cloud [description\|session_id\|url]`, `--environment <environment_id>`, `--teleport [session]`, `--remote-control`, `--bg`. Commands `agents`, `attach`, `logs`, `stop`, `ultrareview`, `setup-token` |
| 10-24 | `claude agents --help`, `auth --help`, `auth status --help`, `ultrareview --help`, `attach --help`, `logs --help`, `respawn --help` | `agents --json` lists local sessions only. Ultrareview has `--json` and `--timeout` (45-minute default) |
| 10-24 | `jq` over each Claude account's credential file (keys, scopes and plan only) | Both accounts: `subscriptionType` `max`, `rateLimitTier` `default_claude_max_20x`; scopes include `user:sessions:claude_code`; a refresh token is present |
| 10-24 | `jq` over each account's `.claude.json` | One account caches a GitHub web connection status of `not_connected`; the other has no such record |
| 10-24 | `strings` over the installed binary (285,793,528 bytes, SHA-256 prefix `60d7eb7f12fbb28a`) | Paths `/v1/sessions`, `/v1/sessions/{id}/events`, `/v1/code/sessions`, `/v1/code/sessions/{id}/events`, `/v1/code/sessions/watch`, `/v1/code/triggers`, `/v1/environments`. Field names `session_context`, `git_repository`, `seed_bundle_file_id`, `environment_id`. Beta header `ccr-byoc-2025-07-29` |
| 10-24 | `git bundle create <scratch> HEAD`, then `git archive HEAD` | Branch bundle 95.6 MiB (about 100.2 MB, at D1's limit). Tracked snapshot 41.5 MiB as tar.gz |
| 10-25 | `claude --version`; size of the same binary | Unchanged: `2.1.302`, 285,793,528 bytes |
| 10-25 | `strings` over the binary, then `grep` for the trigger client | The code behind the CLI's `RemoteTrigger` tool. `run`: `POST /v1/code/triggers/${trigger_id}/run`, sending the caller's body minus `trigger_id`. Every action uses the auth mode `teleport-org` (the account's login) and an `anthropic-beta` header; the binary holds the value `ccr-triggers-2026-01-30` (that it is this header is inferred). `isReadOnly` is true for `list`, `get`, `list_runs` and `get_run_log` only |
| 10-25 | Loading the `RemoteTrigger` tool schema in this session (not called) | `run` takes "optional body". `list_runs`: `GET /v1/code/sessions?trigger_id=…`, "each trimmed to id, title, status, timestamps and its claude.ai link". "A fire that was skipped or refused before a session existed (routine paused, a fire cap or a 429 on run, …) … leaves no row." `get_run_log`: the "newest 200 events: provisioning, prompt, tool calls and errors, permission prompts and denials, API retries, final result" |
| 10-25 | `strings` for account settings | Path `/api/oauth/account/settings`; fields `grove_enabled`, `grove_notice_viewed_at`; events `grove_privacy_settings_viewed`, `grove_policy_toggled` |
| 10-25 | `jq` over each account's `.claude.json` (key paths and booleans only) | A `groveConfigCache` entry per cached organization, each `grove_enabled: true`, on both accounts. Whether this flag is the account's training choice or only marks that the consumer data-use policy applies is not established (U0) |
| 10-25 | `git apply --cached --check` of result 73 in a scratch index read from `origin/main` | Applies cleanly |

### 1.12 What is not observable without a cloud session

S0 answers each row. The budget is about six short sessions on one account
(decision 1); the last column places each row.

| # | Unknown | Observation step | Where |
| --- | --- | --- | --- |
| U0 | Is model training off on both accounts, and which field shows it? | The operator turns off data use for model improvement on both accounts at the D11 settings page. S0 reads `GET /api/oauth/account/settings` (the read the CLI makes) for both accounts before and after; the field that flips is the training choice | No session |
| U1 | Does a run check out an exact published head? | The assignment names a published lane branch and SHA; read `git rev-parse HEAD` from the tool result in events | A |
| U2 | Do `/model <id>`, `/effort <level>` and `/fast` sent with `claude -p --cloud` run as commands (D1 documents them typed in a session), and where does the run report its model? | Send each; read events for the command result and a model field | A |
| U3 | Shapes of `GET /v1/code/sessions/{id}` and `…/events`: status values (running, idle, waiting on permission, archived), paging, event ordering, and whether the final assistant message and Bash results come back whole with exit codes recorded by the harness. Which event ends a turn, and whether a queued follow-up's user event is recorded when it is queued or when its turn starts | The session prints outputs of 1 KB, 30 KB and 100 KB with SHA-256; compare byte counts and digests with the events; run one failing command. Queue two parts while the first turn is still running, each asking for a `Receipt <token>` first line; read the events after each send and after the session goes idle, and note where each user event, assistant message and turn end sits | A |
| U4 | The largest follow-up `claude -p --cloud` accepts | Send 32 KB, 64 KB and 128 KB messages on stdin; read `ok` and the events | A |
| U5 | Does the read-only connection refuse a push and a comment? | First, from this machine with its normal write-capable `gh` login, calibrate both requests once: `POST repos/{repo}/git/refs` for a fresh `refs/heads/delegatus-probe-<nonce>` with an all-zero SHA, and `POST repos/{repo}/issues/{closed issue}/comments` with an empty body. Each must answer 422 and create nothing. Then in session A the same two requests through the proxy must answer 401, 403 or 404. Only when both are refused: `git push origin HEAD:refs/heads/delegatus-probe-<nonce>` of the already published head. A push that succeeds stops the spike; Delegatus deletes the probe ref with its own credentials and reports it | A |
| U6 | Can a setup script install Bun 1.4.0 and run `bun install --frozen-lockfile` through the security proxy inside the five-minute cache budget? How long do `bun x tsc --noEmit` and one touched test take on 4 vCPU? Can Chrome for Testing be fetched, and do one kanban driver block and one phone driver block render? | A setup script mirroring the `Dockerfile` deps stage, timed; then the drivers with `CHROME_BIN` set; look at one frame from each | B |
| U7 | Can a running session be stopped or archived without the web UI, and what does archiving do to the run's status? | Look for the call in the sessions endpoints; try it on session D | D |
| U8 | Which CLI call refreshes an expired access token without side effects, and how two concurrent refreshes behave | Compare `expiresAt` in the credential file before and after `claude auth status --json` and after a `claude -p --cloud` send | No session |
| U9 | Can a session start from a tree that is not on GitHub, for the decisive pre-push checks? | `CCR_FORCE_BUNDLE=1 claude --cloud "<task>"` from a throwaway repository with no remote, under a pseudo-terminal with `--debug api`; record the creation call and whether events carry exit codes | E |
| U10 | How a run waiting on an auto-mode permission prompt shows in status | Ask the session for an action that matches an ask rule | A |
| U11 | What the run call answers (session id or not); whether body text reaches the session verbatim, in which event and field; how long until `list_runs` lists the run, and how long after that its prompt event appears in the events. Both delays are recorded only: no design step concludes from an empty list, or from a listed run with no prompt event yet, that no session or no nonce exists | Run once with a nonce in the body; read the answer, then `get_run_log` and the first events page for the nonce; list immediately, after 30 seconds and after five minutes, and read the first events page of the listed run at each of those times. The record states whether L1 can bind a run to its attempt (4.4 step 4). If the call is unusable, start session A with `claude --cloud` from the logged-in CLI under a pseudo-terminal and record the creation call (L3) | A |
| U15 | Receipts for follow-ups: does a message queued with `claude -p --cloud` appear in the events as a user event with its text whole, how soon after `{ok: true}`, and which `{ok: false}` errors and stderr failures leave nothing queued? What does a send killed by its deadline leave? | Send three short parts with distinct headers and read the events after each; send one with an invalid session id and one with the login file unreadable; kill one send one second after start, then read the events for five minutes | A |
| U12 | Does a diff exported as numbered base64 blocks come back whole, and does it survive the VM pausing between export and read? | Session C makes a small change, exports it, idles past the pause, then gets one follow-up; compare digests | C |
| U13 | How many sessions run at once on one Max account | Start session D while C is running | D |
| U14 | The task record: fields naming its repository, environment, model, connectors and triggers; whether a task can exist with no trigger | `GET /v1/code/triggers/{id}` on the task the operator created | No session |

Session F is the reserve, used only to repeat a step that failed for a reason
outside the question it asks.

## 2. The Codex Cloud integration on `main`

### 2.1 Stage runtime: PR #3302, merged as `0c7f7a89`

- `src/lib/pipelines/types.ts:107` and `:257`: `runtime?: "codex-cloud"` on
  `PipelineStageInput` and `PipelineAttemptDefinition`; `:408`: `cloud?:
  CloudStageAttempt` on `PipelineStageAttempt`.
- `src/lib/pipelines/cloudStage.ts`: `CLOUD_STAGE_TIMEOUT_MS = 30 min` (line 5),
  `CloudThreadReference` (line 10), `CloudStageAttempt` (line 13; phases
  `reserved | submitting | polling | completed | failed`), `CloudStageClient`
  (line 48: `supportsModel`, `submit` with one `prompt` string, `poll`,
  `readFinalMessage`, and `readDiff`, "Reserved for subsequent slices"),
  `cloudStageConfigurationError` (line 105: only read-only Codex reviewer or
  verifier run stages, an explicit model, no outputs), `cloudServiceTierError`
  (line 120), `cloudTransportError` (line 125), `cloudPollDelay` (line 132).
- `src/lib/pipelines/cloudHostedClient.ts`: the hosted Codex app-server client,
  pinned to `gpt-6.1-sol` (line 15). `HostedConnection` (line 174),
  `resolveHostedCloudEnvironment` (line 281), `openHostedCloudSession`
  (line 304), `createHostedCloudStageClient` (line 325; `thread/start` at
  line 384, `turn/start` at line 404).
- `src/lib/pipelines/cloudHostedErrors.ts`: `HostedCloudFailure =
  "unavailable" | "cloud-limit" | "account-limit" | "invalid"` (line 1),
  `HostedCloudError` (line 4), and the mappers `hostedRpcFailure`,
  `hostedHttpFailure` (401, 403 and 429 are `account-limit`; 5xx is
  `unavailable`) and `hostedNetworkFailure`.
- `src/lib/pipelines/engine.ts`: `PipelinePorts.cloudClient` (line 279), set to
  `hostedCloudStageClient` in the default ports (line 1743);
  `startCloudStageJob` (line 8019), a bounded controller job outside the lane
  mutation lease; the cloud prompt (line 8096: `renderStagePrompt` plus cloud
  runtime lines, through `hardenedRedact`); `cloudExecutionFence` (line 8162);
  `sameCloudIntent` (line 8169); `tickCloudStage` (line 8186), which refuses an
  interrupted `submitting` record (line 8229); dispatch from the run-stage tick
  (line 8256); the configuration violation in stage validation (line 12588).
  The lane must be an owned, published branch whose head equals the accepted
  head. Errors and timeouts fail the attempt; nothing falls back to local.
- `src/lib/projects/settings.ts:195`: `codexCloudEnvironmentId(project)`. Empty
  disables the runtime.
- `src/lib/mcp/server.ts:3928`: `runtime: z.literal("codex-cloud")` in the
  stage schema.
- `src/lib/pipelines/controllerPass.ts:49`: indexes `cloud.nextPollAt` and
  `cloud.deadlineAt`, so waiting cloud work causes no whole-store scan.

### 2.2 Checks: PR #3330, merged as `16f00de7`

- `scripts/cloud-checks.ts`: `runCloudChecks` (line 18) tries the cloud twice,
  then runs locally once; `account-limit` exits 75 and `invalid` exits 1, with
  no fallback. `connectCloud` (line 44) opens its session through
  `openHostedCloudSession` and `resolveHostedCloudEnvironment`, and its errors
  are `HostedCloudError`: authentication, environment resolution and RPC are
  already shared with stage execution. `AppServerCloudTransport` (line 205)
  keeps its own thread and turn sequence (`thread/start` at line 233,
  `turn/start` at line 250) and checks harness-recorded command results with
  `isExactCommand` (line 154).
- `scripts/cloud-check-settings.ts`: the choice `cloud | local` in local git
  config: `delegatus.checks`, a lane key and a stage key; project default
  `cloud` (line 27).
- `src/app/api/pipelines/[id]/checks/route.ts`,
  `src/components/pipelines/PipelineCheckSettings.tsx`,
  `src/components/kanban/PipelineChecksPopover.tsx` (the lane menu's «Checks»
  row) and the MCP tool `pipeline_checks` (`server.ts:4055`, scopes `stage`,
  `lane` and `project`) set it.

### 2.3 Stage input composer: Cloud result 73, still unapplied

The diff adds `src/lib/pipelines/cloudStageInput.ts` with
`composeCloudStageInput`, `composeStageText` in `stageInput.ts`,
`StagePromptContext` in `prompts.ts`, and `scripts/render-cloud-input.ts`. The
composer renders with the local composer, puts the learned-rules block from
`learnedRulesForLaunchProfile` in front, and splits the result on code-point
boundaries below `MAX_STRUCTURED_TEXT_BYTES` (32,000,
`src/lib/runtime/structuredContent.ts:40`). A source conversation is accepted
only as a handoff digest. The same diff also adds `startCloudStage` with a
further Codex transport interface, `CloudStageTransport`.

### 2.4 The seat's cloud-run tool

Outside the repository, under `$HOME/.local/state/delegatus-cloud-run/`, a
Node tool runs `cloud-run launch <brief>`, `status --all` and `collect <name>`.
`collect` writes `results/<name>.diff`, `.md`, `.meta.json` and `.proof.json`,
with a cloud-computed SHA-256. It has its own copy of the Codex client. Its
results reach the repository through "Apply Codex Cloud result N" lanes.

### 2.5 What this means for a second provider

- The Codex thread and turn sequence exists in the hosted stage client, in the
  check transport and in the seat tool, and result 73 would add a fourth if
  applied as written. Authentication and errors are already shared, and
  `HostedCloudFailure` is the vocabulary both cloud paths classify with.
- The setting lives in two places: project settings for stages, git config for
  checks.
- Codex cloud stages get no learned rules: `engine.ts:8096` builds the cloud
  prompt with `renderStagePrompt`. Only the local spawn path composes them:
  `src/lib/runtime/structuredSpawn.ts:2118` appends them to Claude's system
  prompt and `:2198` puts them in Codex's developer instructions.

So slice S1 converges the stage path and the composer before any Claude code
is written, and slice S6 moves the check transport's sequence onto the client.

## 3. Options for the Claude transport

| Step | Option | Benefit | Cost |
| --- | --- | --- | --- |
| Launch | **L1, task run on the subscription login**: `POST /v1/code/triggers/{id}/run`, as `/schedule run` does | Subscription login only. The feature (Run now, `/schedule run`) and its caps are documented, and the shipped CLI exposes the call as a tool with a written contract. The run clones the published lane from GitHub, so merge-base history is intact and a read-only connection suffices | The HTTP shape is undocumented (U11). One task per account, created on claude.ai. Its model is fixed unless U2 holds. No idempotency key, and Run now on claude.ai starts runs of the same task outside Delegatus (D3), so a run is bound to its attempt only by its answer or by the attempt's nonce in its own events; an unbound outcome stays unknown and is never sent again |
| Launch | L2, `POST /v1/sessions` as `claude --cloud` does | Environment and model per call | Undocumented. With the GitHub App left uninstalled, `--cloud` bundles the local repository, and this repository's branch bundle is at the 100 MB limit |
| Launch | L3, `claude --cloud "<task>"` (formerly `--remote`) from the logged-in CLI, driven through a pseudo-terminal | Documented command on the subscription login | Interactive only (D5); fragile to drive; bundles for the same reason as L2 |
| Read | **R1, `GET /v1/code/sessions/{id}` and `…/events` on the login** | The only automatable reader for hosted sessions; the shipped CLI reads runs with it | Undocumented (U3); the log is "condensed" |
| Read | R2, teleport | Documented | Interactive, and needs the session's branch on GitHub, which a read-only connection cannot push |
| Diff back | **D1, a checksummed patch printed by commands in the session and read from events** | Nothing goes to GitHub. Mirrors Codex's numbered blocks with SHA-256 | Depends on U3, U4 and U12 returning tool output whole |
| Diff back | D2, the session pushes to a private scratch GitHub repository | Documented features only | Needs a GitHub connection with write access, which decision 2 rules out |

Recommended: L1 to launch, documented `claude -p --cloud` follow-ups for the
probe, the input and the export request, R1 to read and D1 to return the diff.
S0 gates all of it.

- **L1 usable** (U11, U3, U15): the run call answers with the session id, or
  its body text reaches the session's events verbatim, so 4.4 step 4 can bind
  a run to its attempt; and a result can be bound to the turn that ran the last
  part (4.4, Poll and read): queued parts appear as user events, a turn-end
  event exists, and session A's final message carried the last part's receipt
  line. S3 builds the provider on L1.
- **L1 unusable** (refused, a run that can be bound neither way, or a result
  that cannot be bound to its last part): the
  Claude provider is not built for stages. S3 is not started, Claude's
  capabilities stay false, the runtime control shows Claude cloud disabled with
  the reason "Claude cloud launch not available", and every Claude stage runs on
  this machine as today. L3 stays S0's own way to open probe sessions. A stage
  launch over L3 or L2 would need its own design and is deferred (6): L3 cannot
  run under `-p` (D5) and both bundle a repository whose branch bundle sits at
  the 100 MB limit. S1, S2, S4's Codex half, S5 (Claude shown not ready) and
  S6 are still built; S3, S4's Claude half and S7 are not.
- **U3, U4 or U12 fails:** decision 4 applies. Claude cloud keeps review and
  verify stages, which need only the final message.

## 4. Design

### 4.1 The runtime is a stage field, beside engine and model

- `src/lib/pipelines/types.ts`: `export type PipelineStageRuntime =
  "codex-cloud" | "claude-cloud";` used by `PipelineStageInput.runtime` and
  `PipelineAttemptDefinition.runtime`. A stored stage without it runs on this
  machine, as today.
- The runtime must match the engine: `claude-cloud` requires engine `claude`.
  When the operator switches a cloud stage's engine, the UI writes
  `${engine}-cloud`, so "cloud" stays chosen, or drops to this machine with a
  visible reason when that engine's provider is not ready. A pipeline mixes
  providers by giving each stage its own engine.
- Stored values stay as PR #3302 wrote them. `stageDigestInput` keeps
  `stageRuntime: "codex-cloud"`, so no stored digest changes.
- MCP (`src/lib/mcp/server.ts`): `runtime: z.enum(["codex-cloud",
  "claude-cloud", "local"]).optional()` in the stage schema and in
  `override-stage`. `local` is accepted on requests only, to say "this machine"
  where a default would otherwise apply (4.12); it is never stored. The voice
  companion asks the seat, which uses that tool, as it already does for check
  settings.
- `normalizeStages` and `patchPipeline` keep calling
  `cloudStageConfigurationError`, which becomes provider-aware and refuses a
  stage kind the provider has not proven (4.2).

### 4.2 One interface, two providers

`src/lib/pipelines/cloudStage.ts` stays the seam. S1 changes it to:

```ts
export type CloudProviderId = "codex" | "claude";
export const CLOUD_PROVIDER: Record<PipelineStageRuntime, CloudProviderId> = { "codex-cloud": "codex", "claude-cloud": "claude" };

/** Moved here from cloudHostedErrors.ts (which re-exports it), so stages and
 * checks keep one vocabulary. */
export type CloudFailureClass = "unavailable" | "cloud-limit" | "account-limit" | "invalid";
export class CloudFailure extends Error {
  constructor(message: string, readonly failureClass: CloudFailureClass, readonly retryAfterMs: number | null = null) { super(message); }
}
/** Setup the cloud cannot run safely: no task for the account, task paused or off,
 * connectors attached, GitHub write access proven, training not confirmed off. */
export class CloudNotReady extends Error {}

/** What the provider has proven for this project and account; S0 and the readiness record fill it. */
export type CloudCapabilities = { readOnlyStages: boolean; writeStages: boolean; uiDrivers: boolean; checks: boolean; reason: string | null };

export type CloudReference =
  | { provider: "codex"; threadId: string; turnId: string; hosted?: { environmentId: string; cwd: string; model: string } }
  | { provider: "claude"; sessionId: string; taskId: string; nonce: string; probe: "pending" | "refused";
      parts: number; tokens: string[]; queued: number; sending: { part: number; since: string; outcome: "pending" | "unknown" } | null;
      lastPartEvent: string | null; eventsCursor: string | null };

export interface CloudStageClient {
  readonly provider: CloudProviderId;
  capabilities(input: { project: string; account: AccountContext }): CloudCapabilities;
  supportsModel(model: string, reasoningEffort: string | null, account: AccountContext): boolean;
  /** Creates the remote task. Codex sends its whole input here; Claude sends nothing yet. */
  submit(input: { purpose: "stage" | "readiness-check"; target: string; branch: string; headSha: string; parts: string[]; model: string; reasoningEffort: string | null;
    allowProviderModelFallback: false; account: AccountContext; signal: AbortSignal; assertCurrent: () => void }): Promise<{ taskId: string; taskUrl: string; reference: CloudReference }>;
  /** One bounded step of what follows creation. Claude: the GitHub write probe, then the next part. Codex: done at once.
   * Empty `parts` is the readiness check (4.4): the probe and nothing after it. */
  deliver(input: CloudTaskAccess & { parts: string[] }): Promise<{ reference: CloudReference; done: boolean }>;
  poll(input: CloudTaskAccess): Promise<CloudTaskObservation>;
  readFinalMessage(input: CloudTaskAccess): Promise<{ message: string; model: string | null }>;
  readDiff(input: CloudTaskAccess): Promise<{ patch: Buffer; sha256: string }>;
  /** Best effort; "unsupported" leaves the session running and the fence ignores it. */
  cancel(input: CloudTaskAccess): Promise<"stopped" | "unsupported">;
}
```

- `submit` takes the parts from the shared composer (4.5). Codex sends them as
  turns. Every transport error is a `CloudFailure` or `CloudNotReady`, so the
  engine and the check runner classify one way. `purpose: "readiness-check"`
  is Claude's probe-only run (4.4, Readiness record); Codex refuses it as
  `invalid`.
- `poll` reports `completed` only when the provider has bound a finished turn
  to the last input it sent, and `readFinalMessage` reads only that turn. Codex
  already does this: it finds the turn by the accepted `turnId` and reads only
  that turn's items (`cloudHostedClient.ts:363` and `:429`–`:432` at
  `e28d793c`). Claude binds by the receipt of 4.4 (Poll and read).
- `PipelinePorts.cloudClients: Partial<Record<CloudProviderId,
  CloudStageClient>>` replaces `cloudClient` (engine.ts:279).
  `defaultPipelinePorts` registers `hostedCloudStageClient`, and
  `claudeCloudStageClient` from S3 on.
- In `startCloudStageJob`, account resolution uses the stage's engine through
  the existing `resolveProjectSpawn` port. The fence and job structure stay as
  they are. One `cloudLabel(provider)` helper names the provider in messages,
  replacing the literal "Codex Cloud".
- Capabilities start as: Codex, read-only stages yes (PR #3302), write stages
  after S4, checks yes through the check runner. Claude: read-only and write
  stages only after S0 and the account's readiness record have proven them;
  checks stay false (4.10).

### 4.3 Attempt record and states

`CloudStageAttempt` keeps its fields and gains:

- `provider: CloudProviderId`. An absent value reads as `codex`, for records
  written by PR #3302.
- `target`: the launch target, a Codex environment configuration id or a Claude
  task id. The old key `environmentId` is still read.
- `reference: CloudReference` replaces `thread`; old records map onto it.
- `phase`, extended to `reserved → submitting → delivering → polling →
  collecting → completed | failed | fallen-back`. `delivering` covers Claude's
  write probe and multi-part input (`reference.probe` tells them apart);
  `collecting` covers the diff export.
- `nonce: string`, generated and persisted at `reserved`, before any call.
- `candidates: Array<{ sessionId: string; createdAt: string; state: "new" |
  "pending" | "read"; carriesNonce: boolean | null; lastReadAt: string | null
  }>`, for reconciling an unknown run outcome (4.4 step 4).
- `submittingAt: string`, `submitOutcome?: "unknown"` with `unknownSince:
  string`, `retries: number`, `failureClass?: CloudFailureClass`, and
  `fallback?: { cause: "unavailable" | "cloud-limit" | "not-ready"; detail:
  string; at: string; abandoned: "stopped" | "unsupported" | null;
  lateSession: string | null }`.

The phase is durable, so a restart resumes at the recorded step. A
`submitting` record without a receipt is ambiguous: Claude reconciles it only
by the attempt's nonce (4.4 step 4) and never submits again; Codex keeps
refusing resubmission.

### 4.4 The Claude provider

New file `src/lib/pipelines/cloudClaudeClient.ts`, with fake-transport tests.

**Setup, once per account, by the operator on claude.ai**

All of it runs on the subscription; Delegatus stores no credential of its own.

1. Training off (decision 3): data use for model improvement off at the D11
   settings page, on both accounts. Retention is then 30 days.
2. GitHub connected read-only (decision 2). Recommended: the browser
   onboarding's Claude GitHub App authorization, with the install step skipped
   and the App not installed for this repository's owner. This repository is
   public, so sessions clone it (D1, D12). The other way the operator allowed:
   `/web-setup` run with `GH_CONFIG_DIR` pointing at a scratch `gh` config
   signed in with a fine-grained token that can only read public repositories,
   so the token `/web-setup` sends is that one. `/web-setup` with this machine's
   normal `gh` login is excluded: that token can push and comment.
3. One cloud environment: Trusted network, the setup script U6 settles (Bun
   1.4.0 and frozen dependencies, as the `Dockerfile` deps stage does, plus
   Chrome for Testing when U6 proves it), and no environment variables holding
   secrets.
4. One scheduled task: this repository, that environment, the model the
   account's cloud stages use, **every connector removed**, the saved prompt
   from `docs/cloud/claude-task-prompt.md`, and no API trigger. If the form
   requires a trigger (U14), a one-off run a year ahead; the saved prompt makes
   a run without a Delegatus assignment end at once. The saved prompt says the
   assignment comes in the follow-up messages that carry the run's nonce: run
   the probe commands first and stop, then work on the named head, never push,
   open or comment on nothing on GitHub, and end with the fenced verdict.

Project setting `claudeCloudTasks: Array<{ accountId: string; taskId: string;
model: string }>` in `src/lib/projects/settings.ts`, written through `PUT
/api/projects/settings` under the same operator authority as
`codexCloudEnvironmentId`. Empty disables the provider.

**Readiness record**

`statePath("cloud/claude-readiness.json")` holds, per account and task, `{
checkedAt, trainingOff, taskEnabled, connectors, repository, lastProbe:
"refused" | "write-access" | null, capabilities, failures }`. The fields up to
`repository` come from two read-only calls on the login, `GET
/api/oauth/account/settings` and `GET /v1/code/triggers/{taskId}` (U0, U14).
They are refreshed at most once an hour per account, by the controller job
that is about to submit. The provider is off for the project until a probe has
been refused and the record shows training off, the task enabled, zero
connectors and this repository. Stage submission (Submit, step 1) requires that
ready record.

A new install or a newly added account has no probe yet, so stage submission
can never pick it. The readiness check is its own admission, through the same
client and controller jobs:

- A Settings «Check» button, per account and task, starts one controller job
  `cloud.claude.check` (one per account and task at a time; a second press while
  one runs joins it). It first refreshes the two read-only calls. Training not
  off, the task paused or off, any connector, or another repository: the record
  stores the reason, no run call is made, and the provider stays off.
- With those static conditions met, it is admitted whatever `lastProbe` holds:
  `null` on a fresh record, `"write-access"` after the operator fixed the
  GitHub connection, or `"refused"` for a recheck. It calls `submit` with
  `purpose: "readiness-check"` and `deliver` with no parts, so the run gets the
  probe part (Submit, step 5) and nothing after it. The check is persisted
  under the account's readiness entry with the same `phase`, `nonce`,
  `submittingAt`, candidate and `sending` fields as a stage attempt, so the
  run-call-once rule, reconciliation (step 4) and receipts (step 8) hold for it
  across a restart.
- Both refusals write `lastProbe: "refused"` and the capabilities; the
  provider becomes ready for the project. Either 422 writes `"write-access"`
  and raises the attention item. No probe result within ten minutes writes no
  `lastProbe` and records `cloud-limit`. In every case the session is then
  cancelled where U7 proved `cancel`, and otherwise left to end on the saved
  prompt; no assignment part is ever sent.
- Stage attempts run the same probe per session (step 5). A stage attempt's
  probe that answers 422 also writes `"write-access"`.

**Submit**

1. The account comes from `resolveProjectSpawn` for engine `claude`, among the
   project's accounts that have a task and a ready record. The engine binds the
   attempt, as in PR #3302, and records `{ provider: "claude", phase:
   "reserved", target: taskId, branch, headSha, deadlineAt, nonce }`.
2. `phase = "submitting"` and `submittingAt` are persisted before the call.
   Each attempt makes the run call at most once, and each nonce is sent in
   exactly one run call. Runs of the same task may overlap: Run now on
   claude.ai, a schedule, or another attempt may start one at any moment (D3).
   Step 4 binds by nonce, so nothing depends on Delegatus being the only
   starter.
3. `POST /v1/code/triggers/{taskId}/run` on the login, with the body `Delegatus
   stage <pipeline>/<stage> attempt <n>, nonce <nonce>` (a readiness check
   sends `Delegatus readiness check <check id>, nonce <nonce>`). Answers:
   - A session id stores it and moves to `delivering`.
   - A refusal answer means no session exists. The CLI's tool contract states
     that "a fire that was skipped or refused before a session existed
     (routine paused, a fire cap or a 429 on run, …) … leaves no row" (1.11),
     and S0 records the answers it sees. 429 (the task's 30 per hour) is
     `cloud-limit`, with `Retry-After` when sent. 401 is `account-limit`, so
     the existing account hold asks for the login to be renewed. 400, 403 and
     404 (task missing, paused or turned off after 72 hours without GitHub) are
     `CloudNotReady`. A connection that never opened (DNS failure, connection
     refused) sent nothing and is `unavailable`. Only these outcomes allow
     4.8's retry, which makes a new run call with a new nonce.
   - Anything else leaves the outcome unknown: a 5xx, a reset or timeout after
     the request was written, a 2xx without a session id, or a restart that
     finds `submitting` with no recorded answer. The engine persists
     `submitOutcome: "unknown"` and `unknownSince` and goes to step 4. It never
     makes a second run call for this attempt.
4. Reconciling an unknown outcome binds only by the nonce, and only when U11
   showed that body text reaches the session's events. Each due tick lists
   `GET /v1/code/sessions?trigger_id=<taskId>` and keeps the runs created at
   or after `submittingAt` minus a 60-second clock allowance. Each candidate
   has a state on the attempt: `new`, `pending` (its events were read and hold
   no prompt event yet, for example only provisioning) or `read` (the prompt
   event that U11 names was read). A run appearing in the list does not mean
   its prompt event is visible yet; nothing documented makes the two appear
   together, and U11 records the gap without bounding it. Each tick reads the
   first events page of at most five candidates that are `new` or `pending`:
   never-read first, then the least recently read, then oldest `created_at`,
   then id, so a run that stays `pending` cannot starve a newer one. Each read
   time is stored on the candidate. A `pending` candidate is read again
   on every due tick while the window below lasts; only a `read` candidate is
   final.
   - Exactly one `read` candidate carries the attempt's nonce: adopt it and
     move to `delivering`.
   - A `read` candidate whose prompt lacks the nonce is someone else's (Run
     now, a schedule, another attempt). It is never adopted, never read again
     and never receives a part.
   - Two or more carry the nonce: adopt none; the outcome stays unknown.
   - No match, `pending` candidates included: the outcome stays unknown. An
     empty or nonce-free list proves nothing, because no source bounds how soon
     a created run becomes visible (U11 records the delay only).
   - The attempt keeps reconciling for ten minutes from `unknownSince`. After
     that it falls back to this machine as confirmed `unavailable` (4.8),
     without a retry: a second run call could start a second session. When U11
     showed that body text does not reach the events, the window is skipped and
     the fallback is immediate.
   - After the fallback, the controller keeps listing and reading `new` and
     `pending` candidates at the `cloudPollDelay` backoff until the attempt's
     deadline, still at most five reads per tick. A candidate whose prompt then
     shows the nonce is recorded in `fallback.lateSession`, cancelled where U7
     proved `cancel`, and sent nothing. The saved prompt makes a run that
     receives no assignment end its first turn at once. Later attempts have
     other nonces, so none of them adopts it.
   - The unknown state, every candidate with its state and read time, and the
     late session are persisted on the attempt, so all of this holds across a
     restart: a `pending` candidate is read again after it, and the run call
     is never repeated.
5. `delivering`, probe first. Part 0 asks for exactly two commands: the U5
   refs request and the U5 comment request, through `gh api` and the proxy.
   `deliver` reads their harness-recorded results from events and matches the
   command text exactly, as `isExactCommand` does for checks. The refs request
   names `delegatus-probe-<nonce>`, so only this attempt's probe can match, and
   only results after the probe part's own user event count. Both refused (401,
   403 or 404): `probe = "refused"`, continue. Either 422: `CloudNotReady("GitHub
   write access in the cloud session")`; no assignment part is sent, the
   readiness record turns the provider off and an attention item names the fix.
   No matching result within ten minutes: `cloud-limit`.
6. If U2 holds, send `/model <stage model>` and, when the effort is explicit,
   `/effort <effort>`. Otherwise `supportsModel` is true only for the task's own
   model, and an explicit effort is refused, the same way PR #3302 refuses an
   unverified service tier. Fast mode stays refused until U2 shows `/fast`.
7. Each part goes on stdin of `claude -p --cloud <sessionId> --output-format
   json`, so stage text never appears in a process argument list. The command
   runs under `claudeManagedEnvironment(home)` (`src/lib/accounts/claude.ts:944`)
   from a scratch working directory, with a 25-second deadline inside the
   controller job's 30-second bound, a process-group kill, and spawned from the
   main thread. These follow-ups arrive as the account's own messages; text in
   the run call arrives marked untrusted (D3), which is why it carries only the
   header.
8. Every follow-up (the probe, `/model`, `/effort` and each part) is sent at
   most once unless its refusal is proven. Delivery does not rely on the model
   ignoring repeats:
   - Each part, the probe included, starts with the header `Input part i/N,
     nonce <nonce>, token <token>, sha256 <digest of the part>`. `token` is
     random per part, generated and persisted in `reference.tokens` when the
     parts are fixed, before the first send; no earlier output in the session
     can contain it. A slash command cannot carry a header; its receipt is a
     user event with exactly that text after the previous follow-up's receipt
     (U2, U15). Before the CLI is spawned, `reference.sending = { part: i,
     since, outcome: "pending" }` is persisted.
   - `{ok: true}` means the CLI queued the part (D1: it "queues the message
     into the session and exits without waiting for a reply"). It persists
     `queued = i + 1` and clears `sending`, so the next part may be queued
     behind it. It is no proof that the session has read or run the part; only
     the binding under Poll and read settles the stage.
   - A refusal that S0 recorded as leaving nothing queued (U15: an `{ok:
     false}` error or a stderr configuration failure of that kind) clears
     `sending`. The next tick sends that part once more; a second refusal is
     classified by 4.8.
   - Everything else is unknown: the deadline kill, an exit without parsable
     JSON, an `{ok: false}` error S0 did not classify, or a restart that finds
     `sending` set. The engine sets `outcome: "unknown"` and spawns no CLI.
     Each poll then reads the events after `eventsCursor` for a user event
     whose text starts with that part's header and whose digest matches. This
     is the receipt. A matching event persists `queued = i + 1`, clears
     `sending` and continues with the next part.
   - No receipt within ten minutes of `since`: the part is not sent again. The
     attempt falls back as confirmed `unavailable` (4.8), and the
     session is abandoned with `cancel` where U7 proved it. A missing receipt
     never counts as proof that the part was not queued.
   - When U15 shows that queued follow-ups do not appear whole in the events,
     no part has a receipt and no result can be bound to its last part (Poll
     and read), so S0 records "L1 unusable" (§3) and this path is not built.
9. The phase moves to `polling` once the last part is queued.

**Poll and read**

- Each due tick is one bounded read of `GET /v1/code/sessions/{id}` and the
  events page after `eventsCursor`. Backoff runs from 2 to 30 seconds through
  `cloudPollDelay`. Waiting on a permission prompt (U10) for more than ten
  minutes is `cloud-limit`.
- **Binding the result to the last part.** An idle session and a last
  assistant message prove nothing on their own: the probe turn or an earlier
  part may have ended with a valid-looking verdict, and the last part may still
  be queued with its turn not started. `poll` reports `completed` only when the
  events read so far show, in event order:
  1. the user event of the last part, with its header and digest (its receipt,
     as in step 8), stored as `reference.lastPartEvent`;
  2. after it, an assistant message whose first line is `Receipt <token of
     the last part>`; the runtime lines (4.5) ask for that line, and no turn
     before the last part was read can know the token;
  3. after that message, the turn-end event U3 names, with no assistant event
     after it.

  `readFinalMessage` returns that message without its receipt line. The
  verdict goes through `parsePipelineStageVerdict` (engine.ts:2658), as for
  Codex. The model is confirmed where the events report it (U2, U3). Anything
  short of all three leaves the result unknown and the attempt keeps polling;
  a message with the wrong token or none is never parsed as the verdict. No
  bound result by the deadline is the deadline's `cloud-limit` (4.8), never a
  verdict. `tokens`, `queued` and `lastPartEvent` are persisted, so a restart
  between the last send and the end of its turn binds the same way. A
  follow-up for missing diff blocks (4.6) is bound the same way by its own
  token.
- **Auth.** The account's OAuth access token and organization id are read from
  its own files into memory for each operation, which is what the CLI's
  `teleport-org` mode sends. Delegatus never writes those files. When the token
  has expired, it runs the side-effect-free CLI call U8 settles and reads again.
  An account backed by a third-party provider (`account.claudeProvider`) is
  refused, per D1.

**Deadlines**

`CLOUD_STAGE_DEADLINE_MS` in `cloudStage.ts` sets a per-attempt deadline:
30 minutes for read-only stages, as `CLOUD_STAGE_TIMEOUT_MS` does today, and 90
minutes for build and fix. It is persisted on the attempt and adjusted from S0
and S3 timings.

### 4.5 How stage input and learned rules reach the session

- One composer for every runtime: result 73's `composeCloudStageInput`, applied
  in S1 without its `startCloudStage` transport. Its output is the local stage
  input, with learned rules first. The same scrubs run as for local input:
  `withCurrentRoleMemory`, `withoutStoredLessonsAsync`, and `hardenedRedact` on
  the handoff digest. Then the cloud runtime lines replace the local host, MCP
  and scratch mechanics (`engine.ts:8096`) and add: check out exactly
  `<headSha>` from `origin/<branch>`; do not push; leave changes in the working
  tree; work only after part N/N has arrived, and begin the final message with
  the line `Receipt <token>`, copying the token from part N/N's header (4.4,
  Poll and read).
- Learned rules arrive as the first assignment part after the probe. Local
  Claude gets them in the system prompt and Codex in developer instructions; a
  cloud session has neither channel. Delivery is recorded in the memory
  delivery ledger (`MemoryEngineStart`) with the cloud session id as the
  conversation id.
- Parts: 32,000 bytes, the size result 73 uses, until U4 measures the real
  ceiling. Learned rules alone may reach `LEARNED_RULES_MAX_BYTES` (120,000,
  `src/lib/memory/roleLaunch.ts:18`), so multi-part delivery is the normal case.
- The repository's own instructions reach the session without Delegatus:
  `CLAUDE.md` (which includes `AGENTS.md`) and `.claude/skills/` are part of the
  clone (D2).

### 4.6 How the result returns

- **Verdict:** the final message ends with the fenced JSON verdict, the same
  contract as PR #3302's cloud stages. For Claude it starts with the receipt
  line and counts only when bound to the last part (4.4, Poll and read). It settles through `tickCloudStage` and
  the existing fail edges.
- **Diff (S4):** for build and fix stages, the runtime lines tell the session
  to run, as its last step: `git add -A`, `git diff --cached --binary <headSha>`
  to a file, then print its byte count and SHA-256, then print it in numbered
  base64 blocks. The block size is the largest output U3 shows returned whole.
  It all happens in the same turn, before the VM can pause and be reclaimed.
  `readDiff` reassembles the blocks from the events of the bound turn only,
  checks count and checksum, and
  returns the patch. When blocks are missing, one follow-up asks for them again.
  A reclaimed VM means `cloud-limit`.
- **Decision 4:** when S0 shows that U3, U4 or U12 does not return output whole,
  Claude's `writeStages` stays false, S4 builds only the Codex half, and Claude
  cloud keeps review and verify stages.
- **Apply (S4, shared with Codex):** new `src/lib/pipelines/cloudPatch.ts`,
  `applyCloudPatch(worktree, headSha, patch, sha256)`. It requires the lane
  worktree clean at `headSha`. It refuses a checksum mismatch, a path outside
  the tree, a symlink pointing outside, or a submodule change, then runs `git
  apply --index --binary --check` followed by the real apply. From there the
  stage settles like a local writer: the controller's settlement commit runs the
  hooks (pre-commit privacy) and the normal publication runs pre-push privacy.
  The patch is kept under the controller artifact directory, outside the
  repository.

### 4.7 Privacy boundary

Nothing reaches GitHub before the privacy gate. Delegatus's own publication is
the only writer of this repository's branches. A Claude cloud session holds a
GitHub connection that cannot write, and each session proves that before it
receives any assignment.

| Hostile input | Layer that refuses | Observable result |
| --- | --- | --- |
| The model runs `git push` | GitHub, because the connected credential has no write access (decision 2); the per-session probe confirms it before the assignment | Push refused in the session. A probe answering 422 stops the run before its assignment and turns the provider off |
| The model comments on an issue or pull request with the built-in GitHub tools or `gh api` | Same credential through the proxy (D2); GraphQL is refused outright | API refusal in the session; the probe's comment request shows it per session |
| A connector on the task posts elsewhere (Slack, mail, trackers) | Setup step 4 removes every connector; the readiness record refuses a task that lists one | Provider off with the reason "connectors on the task" |
| The returned diff contains an account handle, an absolute home path or a fingerprinted value | Local pre-commit privacy in the settlement commit, then pre-push privacy at publication | The stage fails like a local stage with a privacy refusal; nothing is pushed |
| The diff escapes the tree, plants a symlink outside it or changes a submodule | `applyCloudPatch` | Attempt failed: "cloud patch refused: <reason>" |
| A forged or partial diff (blocks missing, reordered or altered) | Byte count and SHA-256 computed in the session, checked locally | `collecting` retries once, then `cloud-limit` |
| A late result from an abandoned session after fallback | The `cloudExecutionFence` and `sameCloudIntent` checks of PR #3302 | Ignored; the attempt stays with the local run |
| The account's OAuth token in a stage input, a process argument, a log or a record | Read into memory inside the transport only; parts go on stdin; the stage input is composed before any credential is read | The token never appears; S3 tests fail any serialized record or spawned argument list that contains it |

What leaves this machine, by decisions 3 and 2026-10-24: the published lane head
(cloned from GitHub), the composed stage input including learned rules, and the
session transcript, which Anthropic keeps 30 days with training off (D11).
Delegatus never changes a session's sharing; sessions are private by default
(D1).

### 4.8 Fallback to this machine

One policy for both providers, in `cloudStage.ts:
cloudFallbackDecision(attempt, failure)`, using the classes checks already use:

| Class | Claude examples | Codex examples | Before a receipt | After a receipt |
| --- | --- | --- | --- | --- |
| `unavailable` | Run call whose connection never opened (DNS failure, connection refused), "Session creation failed", setup script failed, checkout of the head failed; an unknown run or send outcome left unresolved (4.4 steps 4 and 8) | Socket refused or lost, `environmentUnavailable` | One retry after 60 seconds, or `Retry-After` up to 15 minutes. A second failure confirms. An unknown outcome is never retried: it confirms when its window ends | Confirmed: fall back |
| `cloud-limit` | Run call 429 (task's hourly cap); "limit on cloud sessions running at once"; deadline; VM stopped the task; VM reclaimed before export; probe or permission wait over ten minutes | `cloudCapacityExceeded`, `environmentTimeLimitExceeded`, deadline | As `unavailable`. A `Retry-After` beyond 15 minutes confirms at once | Confirmed: fall back |
| `CloudNotReady` | No task for the account, task paused or off, connectors attached, training not confirmed off, probe answered 422 | Environment setting cleared | Fall back at once, raise an attention item naming the setup to fix, mark the provider not ready for the project | Same |
| `account-limit` | Subscription usage window spent; 401 on the login | `usageLimitExceeded`, `unauthorized` | No local fallback (2026-10-24). The account hold re-resolves among accounts that have a ready task, else waits for the reset like a local stage | Same |
| `invalid` | A reply shape S0 did not record, a malformed event page | An RPC refusal outside the lists above | The attempt fails with its reason, as checks do | Same |

Falling back means `phase = "fallen-back"`. The provider's `cancel` runs and its
answer is recorded in `fallback.abandoned`. The same attempt then continues on
the existing local path (the run-stage tick past the cloud branch) with the same
engine, model, effort, account policy and accepted head. Nothing a cloud run
produced is applied. A wrong verdict, an unparseable final message or a red
check is the stage's own result and never triggers fallback.

A retry is a new run call with a new nonce. It is made only after an outcome
that proves no session exists (4.4 step 3). An unknown outcome is never
retried, so a lost answer can neither start a second session nor hand the
attempt someone else's.

### 4.9 In pipelines and on the board

- **Choosing it.** No new control: the runtime is one more choice in the
  existing stage runtime control (`src/components/RuntimePill.tsx` through
  `src/components/stageRuntimeSwitch.ts`, and
  `src/components/pipelines/StagePlaceholderPane.tsx`). The choice is "This
  machine" or "Cloud" (uk: «Ця машина», «Хмара»). It is disabled, with its
  reason, when the provider for that engine is not ready. A pick shows at once
  and is written in the background; a refused write returns to the last stored
  choice with the error beside the control.
- **The mark.** `src/components/kanban/StageGlyph.tsx` draws a stage the same
  way in the graph node, the Stages sheet, the card's pills, the task row and
  the phone. It gains a small cloud mark for a cloud runtime. The stage popover
  names the runtime ("Claude Code cloud" or "Codex Cloud"; uk «Хмара Claude
  Code», «Хмара Codex»), the account label the board already shows, the phase
  word and the deadline. Status stays a dot plus a short popover.
- **Live state.** `src/lib/pipelines/stageChip.ts` maps phases to words:
  `reserved`/`submitting` "Starting in the cloud" (uk «Запуск у хмарі»);
  `delivering` with the probe pending "Checking GitHub access" («Перевіряємо
  доступ до GitHub»), then "Sending the task" («Передаємо завдання»); `polling`
  "Working in the cloud" («Працює в хмарі»); `collecting` "Taking the result"
  («Забираємо результат»); `fallen-back` "Moved to this machine: <cause>"
  («Перенесено на цю машину: <причина>»); `failed` "Cloud run failed: <cause>"
  («Хмарний запуск не вдався: <причина>»).
- **Opening it.** A local stage opens its conversation; a cloud stage's popover
  links to the session (`claude.ai/code/session_…` or the Codex thread link).
  The final message and findings show through the existing verdict popover
  from `cloud.result`. Opening the link needs the browser signed in to that
  account.
- **Checks.** `PipelineChecksPopover.tsx` and `PipelineCheckSettings.tsx` show a
  Claude choice disabled with its reason, since no slice builds Claude checks
  (4.10).
- **Where.** Desktop board, pipeline strip and hub, and the phone pipeline
  screen (`src/components/mobile/MobilePipelineScreen.tsx`), in en and uk,
  light and dark. Over MCP, the pipeline record, and so `get_pipeline` with
  `full: true`, carries `attempt.cloud`.

### 4.10 Checks

- **Heavy checks inside a verify stage**, such as types, touched tests and the
  kanban and phone drivers on a published head, run in a Claude verify stage
  from S3 when U6 holds. The verdict is model-reported, the same trust as a
  local verifier stage.
- **The decisive pre-push gate** keeps Codex Cloud as its default (decision 5;
  `cloud-check-settings.ts:27`). It needs the tree before it is published, and
  evidence produced by the harness itself, independent of model text. For
  Claude both depend on U9, and a tree that is not on GitHub can reach a
  session only as a bundle, through L3 or L2. No slice builds that launch:
  U9 is an S0 observation, and a Claude check job is deferred (6) until a
  design built on S0's answer adds one. Claude's `capabilities.checks` stays
  false, and the check settings show the Claude choice disabled with the
  reason "Claude cloud checks not available".
- One setting vocabulary for checks, `local | codex-cloud | claude-cloud`; a
  stored `cloud` reads as `codex-cloud`, and `claude-cloud` is refused with the
  reason above. The choice stays in git config,
  where PR #3330 put it so the pre-push hook can read it.

### 4.11 Hot paths

- Cloud I/O runs only inside bounded controller jobs outside the lane lease, as
  in PR #3302. `controllerPass.ts` indexes due times, so a tick does no
  per-attempt scan.
- A poll reads one session record and one events page after the stored cursor;
  the work scales with new events. `list_runs` runs only for an unknown
  submit and reads the first events page of at most five `new` or `pending`
  candidates per tick, least recently read first. The readiness reads run at
  most once an hour per account, and a readiness check only on a «Check»
  press.
- CLI sends are child processes with a deadline and process-group cleanup,
  spawned from the main thread, at most one per attempt at a time.
- Every new controller job carries a monitor operation label, for example
  `cloud.claude.poll`.
- No speed or memory gain is claimed. S3 measures local CPU per cloud stage
  against the same stage run locally.

### 4.12 Default runtime for UI review and frontend stages (decision 5)

- **Where.** `defaultStageRuntime(stage, readiness)` in `cloudStage.ts`, called
  by `normalizeStages` when a stage is created (pipeline creation, an added
  stage, the prototype lane template) without a runtime in the request.
- **Which stages.** Effective role `visual-critic`, which is read-only and bound
  to Claude (`src/lib/roles/locks.ts:12` and `:16`). Effective role `builder`
  with `domain: frontend`, which resolves to the `frontend` and
  `frontend-fixes` rows (`src/lib/roles/paramConfig.ts:51` and `:53`), when the
  stage's engine is Claude. A frontend builder bound to Codex keeps its engine
  and its runtime.
- **When.** Only when the Claude provider holds the capability that kind needs
  for the project at that moment: `readOnlyStages` and `uiDrivers` for the
  visual critic (it renders frames through the existing drivers in the VM, and
  its findings cite frame names and measured numbers), `writeStages` for
  frontend builders. Otherwise no runtime is written, and the stage popover
  says "Cloud default not ready: <reason>".
- **Written once.** The default writes `runtime: "claude-cloud"` into the
  stored stage, so a stored stage never changes meaning when readiness changes
  later. Choosing "This machine" clears it, and a request with `runtime:
  "local"` creates the stage without it.
- **Kept out.** Builders in `mode: prototype` stay on this machine: their frame
  directory is ignored output that `publish_prototype_review` reads locally.
- **Checks** keep the default `cloud`, which is Codex Cloud.

## 5. Slices to build, one lane each

| Slice | Depends on | Work | Acceptance |
| --- | --- | --- | --- |
| **S0. Observation spike** | Decisions 1 to 3 (answered 2026-10-25); the operator's setup steps 1 to 4 of 4.4 on one account, and step 1 on the other | No-session steps first: U0, U8, U14, and the local U5 calibration. Then sessions A to E on the one account, F only as a repeat (1.12). Scratch tooling lives in a durable folder outside the repository, named in the task details. Commit `evidence/claude-code-cloud.json` (request and response shapes with ids and tokens removed, timings, sizes, model and status values) and update §1.12 and §3 of this document | Every U row has an observed answer or "not available" with its evidence. At most six sessions, counted from `list_runs` and the send log. Every call used the account's subscription login, read from its own login files. Nothing written to GitHub; if a probe push wrongly succeeds, the ref is deleted, reported, and the spike stops. The record states whether results come back whole, which decides decision 4. It states one launch verdict, "L1 usable" or "L1 unusable" with its evidence (§3): usable needs the session id in the run answer or the body nonce found verbatim in the run's events (U11), and a result bound to its last part: queued parts appear as user events (U15), a turn-end event exists (U3), and the final message of session A carried the last part's `Receipt <token>` line. It states which follow-up outcomes carry a receipt: whether queued text appears whole in the events and which `{ok: false}` and stderr failures leave nothing queued (U15) |
| **S1. One cloud-stage seam** | None open (PR #3302 is on `main`) | 4.1 to 4.3 plus 4.5: runtime union, provider registry, the moved failure vocabulary and `CloudNotReady`, provider-neutral messages, the extended attempt record with old-record reads, `deliver`; apply result 73's composer without its transport and use it for Codex cloud stages | Existing `cloudStage`, `cloudHostedClient`, `engine.cloud` and `scripts/cloud-checks` tests pass. A fake `claude` client proves engine-based dispatch and account resolution. For the same stage, the cloud parts joined equal the local composed input apart from the runtime lines. Codex cloud stages carry learned rules. One stage-side `thread/start` sender exists under `src/` |
| **S2. Fallback to this machine** | S1 | 4.8 for stage attempts of both providers | Fake providers raise each class and `CloudNotReady` before and after a receipt. Tests assert the attempt transitions, exactly one local start on the same head, none for `account-limit`, `invalid` failing the attempt, a late cloud result ignored after fallback, and resumption across a real-process restart (`fixtures/cloudStageRestart.ts`) |
| **S3. Claude provider, review and verify** | S0 with the verdict "L1 usable" (U1, U3, U5, U11, U15 answered), S1, S2. With "L1 unusable" this slice is not started (§3) | 4.4: settings, readiness record, run call, nonce reconciliation, probe, parts with receipts, polling | Fake HTTP and CLI tests: the run call carries the login and no other credential; 429 is `cloud-limit` with `Retry-After`; 401 is `account-limit`; 404 is `CloudNotReady`. Lost run answers, each against a fake that counts run calls and sent parts: a lost answer whose own run appears in the list is adopted by its nonce; a foreign Run now run created after `submittingAt`, alone or listed before the own run, is never adopted and receives no part; two candidates carrying the nonce adopt none; the own run appearing only after the ten-minute window is recorded as `lateSession` and receives nothing, and the next attempt does not adopt it; the own run listed while its events hold only provisioning, with its prompt and nonce appearing on the next tick, is adopted on that tick, and the same holds when a real-process restart falls between the two ticks; a foreign run read the same way gets no part; a candidate that stays `pending` does not stop a newer candidate from being read within the five-per-tick bound; a 5xx answer is unknown; in every case the run call count is one and the own run is adopted at most once. Lost sends: the CLI queues part i and then hangs to its deadline, or answers with its JSON lost, or the process restarts before `queued` is persisted. The receipt in the events advances `queued` with no second send. With no receipt, the part is never sent again, and the attempt falls back after its window. A refusal recorded as leaving nothing queued is sent once more. The fake session counts how often it received each part and the assignment: every count is one. The unknown run, the candidates with their states and `sending` survive a real-process restart (`fixtures/cloudStageRestart.ts`). Result binding: the fake session already holds a valid fenced pass from the probe turn or an earlier part, the last part is queued with `{ok: true}`, its turn has not started and the session reads idle: the stage does not complete. A message with no receipt line, or the token of another part, is never parsed as the verdict. Only the message after the last part's user event, carrying its token and followed by the turn end, completes the stage, also when a real-process restart falls between the last send and the turn end. With no bound result by the deadline the attempt fails as `cloud-limit` and falls back. Readiness check, from an empty readiness store: one «Check» makes exactly one run call and sends exactly the probe part and no assignment; both refusals make the provider ready; a 422 in either request keeps it off with `write-access`; training not off, a connector, the task paused or another repository makes no run call and keeps it off with its reason; a second press while one runs makes no second run call; a lost run answer during a check reconciles by nonce like a stage. A fake probe answering 422 sends no part and turns the provider off; no probe result in ten minutes is `cloud-limit`; parts go on stdin, in order; a task listing a connector is refused. A scan of records, logs and spawned argument lists shows no token. One live review stage on a published lane head, with operator approval, settles with its verdict |
| **S4. Diff return and apply** | S1 for Codex; S3 and S0's whole-output answer for Claude | 4.6 for both providers, or for Codex alone under decision 4; lift `cloudStageConfigurationError` to builder and fix where `writeStages` holds | Checksum mismatch, path escape, outside symlink and submodule change are refused; a privacy-violating line in a cloud diff fails the settlement commit like a local stage; a reclaimed VM before export falls back; one live build stage per built provider settles through publication |
| **S5. Pipelines, board and guide** | S1; Claude states after S3 | 4.9, the Settings rows for both providers (task id, readiness, «Check»), and the user guide in `docs/guide/pipelines.md` and `docs/guide/configuration.md` | On a fresh install with a task id entered and no readiness record, «Check» is enabled and its press starts the check job of 4.4 (one run call, the probe only); the row shows the result, ready or the reason, and the stage runtime control turns Claude cloud on only after a refused probe. Rendered evidence through `kanbanBoard.browser.test.tsx` (one describe block over the existing fixture) and the phone driver: every phase, "not ready" and the default-not-ready line, en and uk, light and dark, at the board's named widths, every frame inspected. The choice reaches the stage over the UI and over MCP, and a refused write rolls back in place |
| **S6. Checks on the shared seam** | S1 | Move `AppServerCloudTransport`'s thread and turn sequence onto `cloudHostedClient.ts`; settle the setting vocabulary, `claude-cloud` included as a refused value (4.10) | One Codex Cloud thread and turn sequence in the repository. PR #3330's tests pass. A stored `cloud` value keeps working. `claude-cloud` is refused for checks with the reason "Claude cloud checks not available" over the UI, MCP and git config, and the hook then runs the checks as the stored fallback says |
| **S7. Default runtime (decision 5)** | S3 for the visual critic with U6's driver answer; S4's Claude half for frontend builders; S5 | 4.12 | Tests: a new visual-critic stage gets `claude-cloud` when ready and no runtime with the reason when not; `runtime: "local"` is respected; stored stages keep their runtime when readiness flips; a frontend builder gets it only with `writeStages`; a Codex-bound frontend builder and a prototype-mode builder are unchanged; the checks default stays Codex Cloud |

The runtime host is not touched by any slice. The Viewer's controller jobs do
the cloud I/O.

## 6. Deferred — not currently justified

- A seat cloud-run tool for Claude. The seat starts Claude cloud work as a
  pipeline whose stage has `runtime: "claude-cloud"`, which gives launch, status
  and collect on the board. The Codex seat tool stays until the seat moves to
  pipelines.
- Self-hosted environments: Team and Enterprise only, and they spend our own
  compute.
- A write-capable GitHub connection with a ruleset on `claude/**`, and a private
  scratch repository as the diff channel: decision 2 chose read-only.
- Launching stages or checks over L3 (`claude --cloud`) or L2 (`POST
  /v1/sessions`), including as a replacement when S0 finds L1 unusable. L3
  cannot run under `-p` (D5). Both bundle the local repository while the GitHub
  App is not installed, and the branch bundle sits at the 100 MB limit. S0 uses
  L3 only to open its own sessions and for U9. Its answers are the input to a
  later design, which would add the launch, its receipt and its recovery to the
  same provider seam. Until then a Claude check job is not built (4.10), and
  with L1 unusable Claude stages run on this machine (§3).
- Ultrareview as a stage: usage-credit billing and a different output contract.
- GitHub Actions as a runtime: inputs and outputs pass through a public
  repository.
- Teleporting cloud transcripts into the local conversation viewer.
- Lessons from cloud stages (the `lessonRequest` answer). A cloud session has no
  Delegatus MCP tools; adding this needs a verdict field and a curator path.
- Role-preset runtime defaults (for example "reviewers run in the cloud"),
  unless question 5 asks for them. Question 5 asked for UI review and frontend
  stages, which moved into 4.12 and S7; every other role stays without a
  default.
- Prototype-mode builders in the cloud: their frames would have to come back
  for `publish_prototype_review`.
- Sessions spanning several repositories, Claude Projects and Claude Tag.
- Archiving or deleting finished cloud sessions automatically.

## 7. Validation against the requirement

| Requirement | Where it is met |
| --- | --- |
| «Менять … где? Там де ти задачу»: chosen where the task's pipeline is set up | 4.1 and 4.9: a stage field in the existing runtime control, over MCP and through the seat for voice |
| «Cloud code … C-L-A-U-D» | 4.4: an Anthropic-hosted Claude Code session started as a scheduled-task run |
| «чтобы там выполнялось всё … для кода» | Review and verify (S3), build and fix (S4), heavy checks in verify stages (4.10) and the decisive gate on Codex Cloud (S6); a Claude gate waits for a design built on U9's answer (4.10, 6) |
| «чтобы парсить» | 4.4 and 4.6: final message and verdict read back, diff reassembled and verified |
| «встраивать пайплайны» | The stage runs inside the normal graph, verdicts and fail edges (4.6) |
| «кодекс cloud … или даже вместе» | 4.1 and 4.2: per-stage provider, mixed in one pipeline, one interface |
| 11:10Z: stage-level runtime with fallback to local | 4.8, S2 |
| 2026-10-25, «Лише підписку» | 1.3, 3 and 4.4: subscription-authenticated sessions only |
| Decisions 1 to 5 | S0 budget (1); 4.4 setup and the per-session probe (2); setup step 1 and the readiness record (3); 4.6 and S4 (4); 4.12 and S7 (5) |
| Spec (1): vendor facts only from Anthropic's documentation or a cheap local probe, unknowns with steps | §1.1 to §1.12 |
| Spec (2): one interface, two providers, no parallel mechanism | §2.5, 4.2, S1, S6 |
| Spec (3): input and rules, result, privacy, fallback, display | 4.5 to 4.9 |
| Spec (4): slices with acceptance | §5 |
| Spec (5): at most five questions | §8 |

## 8. Questions for the operator

All five were answered on 2026-10-25 (Operator decisions). No question is open.

1. **May S0 spend a little Claude subscription usage?** Recommended: yes.
   Answer: yes, about six short sessions on one account, on the subscription
   login.
2. **How should Claude cloud sessions reach this repository?** Recommended:
   read-only. Answer: read-only only, and the probe must prove that a push and a
   comment are refused.
3. **Is Anthropic's cloud trusted like Codex Cloud?** Recommended: yes, with
   training off. Answer: yes, with model training off on both accounts.
4. **If results cannot be read back whole without GitHub, what then?**
   Recommended: review and verify only. Answer: Claude cloud runs only review
   and verification stages.
5. **Which stages run in the cloud by default?** Recommended: none. Answer: UI
   review and frontend stages go to Claude cloud by default; other stages choose
   per stage; checks keep Codex Cloud as their default.
