# Codex Cloud in Delegatus: research and design

## The originating requirement

The operator, 2026-09-29, in the orchestrator conversation that opened this
research lane (quoted verbatim):

> «https://learn.chatgpt.com/docs/cloud - можемо приєднати щоб дивиться розмову
> але запускати задачі в клауді? Інтегрувати якось в делегатуса? Реально?»

And, the same day:

> «Так, запускай дослідницький лейн по Codex Cloud, одну тестову задачу в
> клауді можна.»

In English: can Delegatus attach to Codex Cloud so the operator watches the
conversation while the task itself runs in the cloud, can that be integrated
into Delegatus, and is it realistic. One test task in the cloud was allowed.

## Short answer

Yes, it is realistic, with one limit the operator should know up front: the
conversation is readable **after** a cloud task finishes, and was not readable
while it ran (observation 2.4). Launching a task, listing tasks and fetching
the diff go through the `codex cloud` CLI. The conversation (every command, its
output, exit code and duration, and the agent's messages) is only in an
internal ChatGPT backend endpoint that the CLI itself uses, and it arrives
there as the same Codex app-server v2 items Delegatus already parses for local
Codex runs.

No Codex Cloud environment exists for this repository on any of the four Codex
accounts on this machine. The operator has to create one (section 5) before
Delegatus can run anything of its own in the cloud. The one test task ran
against another of the operator's repositories, as the brief allowed.

Recommendation: option **(b)**. Build it in three slices: a read-only view of
cloud tasks in the feed first, because that is the part the quote asks for
directly, and then a pipeline run stage that runs in the cloud and hands back
a diff that goes through our normal review.

## Evidence discipline

Every claim below is tagged:

- **[observed]**: a command or request was run during this research on
  2026-09-29, and the text says what came back.
- **[source]**: read in the Codex CLI source at tag `rust-v0.159.0` (the
  installed `codex-cli 0.159.0`), fetched with
  `gh api repos/openai/codex/contents/<path>?ref=rust-v0.159.0`, and in an older
  cached checkout at commit `2e4f556` (2026-07-15) for comparison.
- **[inferred]**: a conclusion drawn from observations and left unchecked.

Backend requests were made read-only with the bearer token from an account's
`auth.json`, the way the CLI makes them. No token, account id, user id or
email appears here. Accounts are called A to D. Repository names are given
only for public repositories; private ones are counted. Environment ids are
shortened.

| Account | Delegatus role | Plan tier (id-token claim) | Environments |
|---|---|---|---|
| A | the default Codex account, home `~/.codex` (`legacyHome()` in `src/lib/accounts/codex.ts:107`) | Pro (max) | 3 |
| B | a managed Codex account under `accounts/codex/` | Pro | 7 |
| C | a managed Codex account | Pro (lite) | 0 |
| D | a managed Codex account | Pro | 0 |

---

## 1. Environments

### 1.1 How environment ids are discovered

- **[source]** There is no `codex cloud` subcommand that lists environments.
  `codex cloud exec --help` says `--env <ENV_ID>  Target environment identifier
  (see codex cloud to browse)`, meaning the interactive TUI.
- **[source]** The TUI and `exec` both call `list_environments`
  (`codex-rs/cloud-tasks/src/env_detect.rs`). It reads the git remotes of the
  current directory, calls
  `GET {base}/wham/environments/by-repo/github/{owner}/{repo}` for each GitHub
  remote, then calls `GET {base}/wham/environments` for the whole list and
  merges the two. `{base}` defaults to `https://chatgpt.com/backend-api`
  (overridable with `CODEX_CLOUD_TASKS_BASE_URL`).
- **[source]** `exec --env` accepts either an environment id or an environment
  **label** (case-insensitive, e.g. `Latand/nexus-card-battle`), and refuses an
  ambiguous label (`resolve_environment_id` in `cloud-tasks/src/lib.rs`). So a
  Delegatus caller can pass the `owner/repo` label and needs no id at all,
  as long as the label is unique for the account.
- **[observed]** `codex cloud list --json` returns `"environment_id": null` for
  every task, with only `environment_label` filled in. The task list cannot be
  used to discover ids.
- **[observed]** `GET /wham/environments` returns a JSON array. Each entry
  carries `id`, `label`, `repo_map` (GitHub repository id, full name,
  visibility, default branch), `agent_network_access`, `setup`,
  `maintenance_setup`, `env_vars`, `secrets` (empty here), `task_count` and
  `share_settings`.

### 1.2 Which environments exist

- **[observed]** Account A: `GET /wham/environments` → 200, three environments:
  `Latand/nexus-card-battle` (public, `69f6e561…`, 0 tasks before this
  research), one private personal repository and one private organization
  repository.
- **[observed]** Account B: 200, seven environments (the same public
  `Latand/nexus-card-battle` environment, shared at workspace level, two more
  public organization repositories and four private ones).
- **[observed]** Accounts C and D: 200 with an empty list. For these two,
  `by-repo` answers **400**; for A and B it answers 200. [inferred] The 400
  means no GitHub connection exists on that account.
- **[observed]** For this repository, on A and B:
  `GET /wham/environments/by-repo/github/Latand/delegatus` → `200 []`, and the
  same for the old name `Latand/live-log-viewer-next`. No label in either full
  list names either repository.

**There is no Codex Cloud environment for Latand/delegatus on any account.**

### 1.3 What an environment looks like, and what that means for this repo

- **[observed]** Every environment inspected runs `machine_id:
  wham-public/wham-universal` with `workspace_dir: /workspace`, auto-setup on,
  an empty `setup` script, and `env_vars` pinning language versions, among
  them `CODEX_ENV_BUN_VERSION: 1.2.14` and `CODEX_ENV_NODE_VERSION: 20`.
- **[observed]** Network access is `mode: on` with `preset_allowlist: codex` on
  two environments and `all` on one.
- [inferred] This repository pins Bun 1.4.0 (`Dockerfile:6`). An environment
  created with the defaults runs this repository's scripts under Bun 1.2.14,
  which this repository has never been verified under. The environment's setup
  script must install the pinned Bun and run `bun install --frozen-lockfile`.

---

## 2. Lifecycle and data from one test task

### 2.1 The test task

- **Account:** A (Delegatus's default Codex account).
- **Environment:** `Latand/nexus-card-battle` (public, owner is the operator),
  chosen because no environment exists for this repository and it is the
  operator's public repository, so its output can be quoted here.
- **Command [observed]**, run from a scratch directory outside any checkout:

  ```
  codex cloud exec --env 69f6e56137148191abcda9151af63040 --branch main \
    --attempts 1 "Read README.md and answer in one paragraph what this project is. Do not change any files."
  ```

  It printed one line and exited 0 in five seconds (19:37:14Z → 19:37:19Z):
  `https://chatgpt.com/codex/tasks/task_e_6abc136d19b08320adee1a3a492e6708`

- **Task id:** `task_e_6abc136d19b08320adee1a3a492e6708`
- **Task URL:** <https://chatgpt.com/codex/tasks/task_e_6abc136d19b08320adee1a3a492e6708>
  (it opens only for the account that owns it).
- **Rules kept:** exactly one task, `--attempts 1`, no diff applied (there was
  none), no pull request opened, nothing pushed.

The final answer [observed], from `current_assistant_turn.output_items[0]`:

> Nexus Card Battle is a Telegram Mini App built with Next.js and a custom
> Node/WebSocket server where players assemble decks and battle either a local
> AI or human opponents through live PvP matchmaking. It integrates with
> Telegram for player identity and fullscreen behavior, stores persistent
> profiles, card ownership, and saved decks in MongoDB, and supports
> Docker-based self-hosting so Next.js and long-lived WebSocket traffic can run
> together in production.

### 2.2 The two surfaces

| Surface | What it is | Auth | Stability |
|---|---|---|---|
| **CLI** `codex cloud exec / list / status / diff / apply` | Public commands of `codex-cli`, marked `[EXPERIMENTAL]` in `codex cloud --help` | reads `$CODEX_HOME/auth.json` and refreshes the token itself | ships with the CLI, so it moves in step with the backend |
| **Internal backend** `https://chatgpt.com/backend-api/wham/...` | What the CLI and the TUI call underneath [source] | `Authorization: Bearer <access_token>` plus `ChatGPT-Account-Id: <account_id>` from the same `auth.json` [source, observed] | undocumented; see 2.8 |

The backend endpoints the CLI calls [source, `backend-client/src/client.rs`
and `cloud-tasks/src/env_detect.rs` at `rust-v0.159.0`]:

| Method and path | Used for |
|---|---|
| `GET /wham/environments` | all environments of the account |
| `GET /wham/environments/by-repo/github/{owner}/{repo}` | environments for a repository |
| `POST /wham/tasks` | create a task (body below) |
| `GET /wham/tasks/list?limit&task_filter=current&environment_id&cursor` | task list (`codex cloud list`) |
| `GET /wham/tasks/{task_id}` | the full task record (status, diff, messages) |
| `GET /wham/tasks/{task_id}/turns/{turn_id}/sibling_turns` | best-of-N attempts |

The create body [source, `cloud-tasks-client/src/http.rs`]:
`{"new_task": {"environment_id", "branch", "run_environment_in_qa_mode": false},
"input_items": [{"type": "message", "role": "user", "content": [{"content_type":
"text", "text": <prompt>}]}]}`, plus `"metadata": {"best_of_n": N}` when N > 1.
When the environment variable `CODEX_STARTING_DIFF` is set, the CLI adds a
second input item `{"type": "pre_apply_patch", "output_diff": {"diff": …}}`: the
cloud applies that patch on top of the branch before the agent starts. This
matters for section 3, because a lane's unpushed commits can travel this way.

Delegatus already makes this kind of call: `src/lib/transcribe/chatgpt.ts`
posts to `https://chatgpt.com/backend-api/transcribe` with the same two
headers. Its comment says Node's fetch got a Cloudflare 403 there. **[observed]**
Bun 1.4.0's `fetch` got `200 application/json` from `GET /wham/tasks/{id}` in
this research, and so did Python's `urllib`.

### 2.3 Status transitions

- **[observed]** Polled `GET /wham/tasks/{id}` every 4 s from 19:37:23Z:

  | Time (UTC) | `task_status_display.latest_turn_status_display.turn_status` | assistant `turn_status` | events | body |
  |---|---|---|---|---|
  | 19:37:23 | `pending` | `in_progress` | 0 | 6 295 bytes |
  | (unchanged, byte for byte, for 78 s) | | | | |
  | 19:38:41 | `completed` | `completed` | 18 | 49 231 bytes |

  The two setup logs carry `created_at` 19:37:47 and 19:37:50, and the task's
  `updated_at` is 19:38:40. Submit to done took about 86 s.
- **[observed]** `codex cloud status <id>` printed `[PENDING] Summarize project
  from README.md` / `Latand/nexus-card-battle • 8s ago` / `no diff` and
  **exited 1** while pending, then `[READY] …` and exited 0 once complete. The
  title was generated by the backend (`has_generated_title`).
- **[observed]** `codex cloud list --json` showed `"status": "pending"` then
  `"ready"`.
- **[source]** The CLI maps backend states onto four values: `pending` and
  `in_progress` → `pending`, `completed` → `ready`, `failed` and `cancelled`
  → `error` (`map_status` in `cloud-tasks-client/src/http.rs`). The record
  also carries `cancellation_requested_at` and `turn.error {code, message}`.
  The CLI has no cancel command.

### 2.4 Streaming or polling

- **[observed]** For this task, polling the task record gave **no progress
  while it ran**: the body stayed identical (6 295 bytes, no events, no
  worklog, no `latest_event`) until it switched to `completed` with all 18
  events at once.
- **[source]** The CLI has no streaming call. The TUI refreshes by
  re-requesting the list.
- [inferred] The task took 86 s. A longer task might publish partial events
  mid-run; this one did not, so Delegatus must not promise a live view.
  Whether the ChatGPT web page streams over some other channel was not
  observed.

### 2.5 The conversation and turns

- **[observed]** `GET /wham/tasks/{id}` returns `task` (title, status display,
  `external_pull_requests`, `denormalized_metadata`), `current_user_turn` (the
  prompt as `input_items`), `current_assistant_turn` and, when there is a diff,
  `current_diff_task_turn`. This task had no diff turn.
- **[observed]** `current_assistant_turn.thread_events.events` is a list of
  `{method, params}` records in the **Codex app-server v2 notification
  format**. This task's 18 events, in order: `thread/started`,
  `thread/status/changed`, `turn/started`, five `rawResponseItem/completed`
  (the instruction messages), `item/completed` `userMessage`, `item/completed`
  `reasoning`, raw reasoning, raw `custom_tool_call`, `item/completed`
  `commandExecution`, raw `custom_tool_call_output`, `item/completed`
  `agentMessage` with `phase: final_answer`, a raw message,
  `thread/status/changed`, `turn/completed`.
- **[observed]** An older task on the same account (private repository;
  shapes only) had 156 events: 28 `reasoning`, 23 `commandExecution`, 3
  `fileChange`, 2 `agentMessage`, 1 `userMessage`, 1 `mcpToolCall` item, and a
  983 829-byte record.
- **[observed]** The `thread/started` params carry a full `thread` object
  (`cliVersion`, `cwd`, `gitInfo`, `modelProvider`, …). The assistant turn
  names the model (`model_version: gpt-5.6-sol`), `branch: main` and
  `base_commit_sha` (`79791ac1dd00…`).
- **[observed]** `output_items` held a `message` (the final answer with
  `repo_file_citation` fragments) and a `partial_repo_snapshot` (the README
  lines the answer cited). A task with changes also has a `pr` item carrying
  `output_diff.diff`.
- **[observed]** `worklog.messages` held only the user prompt here. The CLI's
  "messages" come from `output_items` of type `message` plus assistant worklog
  entries [source, `Turn::message_texts`], so **the CLI and TUI show the prompt,
  the final text and the diff, and never the commands**.
- **[observed]** The agent ran with the repository's `AGENTS.md`: its one
  command was `find .. -name AGENTS.md … && cat AGENTS.md && nl -ba README.md
  && git status --short`.

This is the key finding for the "watch the conversation" half of the quote.
Delegatus's transcript reader already understands these items:
`normalizeCodexLine` in `src/lib/session/reader.ts:305` turns an
`event_msg` whose payload is an item-completed lifecycle event with a nested
`item` of a Codex thread-item type (`agentMessage`, `commandExecution`,
`fileChange`, `mcpToolCall`, `reasoning`, `userMessage`, …) into feed records.
The one difference is spelling: the cloud writes `item/completed`, and
`codexThreadItemKind` (`reader.ts:226`) strips only `_` and `-`, so the
adapter renames the method before handing it over.

### 2.6 Command logs

- **[observed]** Each `commandExecution` item carries `command`, `cwd`,
  `aggregatedOutput` (4 853 characters for the test task's one command),
  `exitCode`, `durationMs`, `status` and `commandActions`. This is the
  command log, and it is complete per command.
- **[observed]** `current_assistant_turn.logs.logs` held two setup-script
  entries (`setup_autodetect`, `auto_setup`, type `UserSetupScript`) whose
  value is a `file_…` pointer. The endpoint that returns that file's content is
  not in the CLI source and was not probed.
- **[observed]** `proxy_events` records every network decision of the sandbox:
  nine for this task, `allow` for `github.com`, `allow` for an internal
  `chatgpt.com:18080`, and one `block` for `chatgpt.com:443`.

### 2.7 The diff and PR creation

- **[observed]** `codex cloud diff <id>` on the completed task **exited 1** with
  `Error: No diff available for task …; it may still be running.` The message
  is misleading for a finished task that made no change; a caller must read the
  status first. `list` reported `files_changed: 0`.
- **[source]** The diff lives in `current_diff_task_turn` or
  `current_assistant_turn`, as an `output_diff` item's `diff` or a `pr` item's
  `output_diff.diff`, and `codex cloud apply` runs `git apply` of that text in
  the current directory. `--attempt N` picks a best-of-N sibling.
- **[observed]** The record carries PR fields: `pull_request_status:
  not_created`, `pull_request_data: null`, `external_pull_requests: []`,
  `denormalized_metadata.pushed_branch_name`, `cached_pull_request_data`, and
  `intent: "pr"`.
- **[source]** Neither the CLI nor its backend client has a call that creates a
  PR. The documentation describes opening one from the web page ("commit or
  open a pull request when you're ready").
- [inferred] PR creation happens server-side through the account's GitHub
  connector, triggered from the web page, over an endpoint not seen in the CLI.
  It was not attempted, as the brief forbids it.

### 2.8 How stable the internal backend looks

- **[source]** The task paths (`/wham/tasks`, `/wham/tasks/list`,
  `/wham/tasks/{id}`, `/sibling_turns`, `/wham/environments…`) are identical
  between the July 2026 checkout and `rust-v0.159.0`. Over the same span,
  `backend-client/src/client.rs` changed in 426 lines elsewhere (rate limits,
  accounts, settings).
- **[source]** The CLI parses the task record loosely by hand; its own
  comment says "The generated OpenAPI models are pretty bad. This is a
  half-step towards hand-rolling them." Every field is optional.
- **[source]** The CLI supports two path styles, `/wham/...` on
  `chatgpt.com/backend-api` and `/api/codex/...` on other hosts, which shows
  the API already has at least one alternative spelling.
- [inferred] The envelope (`current_assistant_turn.thread_events.events`) is
  internal and can move without notice. The items inside it are the app-server
  v2 protocol, which Codex versions and publishes a schema for
  (`codex app-server generate-json-schema`), and which Delegatus already
  tracks for local runs. A change to the envelope breaks the view; a change to
  the items would break local Codex rendering too, so it would be noticed
  and fixed in one place.

---

## 3. Integration design

### 3.1 The three options

- **(a)** A "Codex Cloud" run stage whose output is a diff, applied into the
  lane worktree (or opened as a PR), followed by our normal review.
- **(b)** (a) plus a read-only view of the cloud conversation in the feed.
- **(c)** Not worth it.

### 3.2 Recommendation: (b)

Reasons:

1. **The quote asks for both halves.** "дивиться розмову" is the view, and
   "запускати задачі в клауді" is the run. (a) alone leaves the operator
   looking at a diff with no idea what the agent did; the CLI shows only the
   final text (2.5).
2. **The view is cheap because the data is already in our format.** The
   commands, outputs and messages arrive as the app-server items
   `src/lib/session/reader.ts` renders today. Writing them as a Codex
   rollout-shaped transcript file puts them in the feed, search, the activity
   export and the board with no new renderer.
3. **The run has a real payoff on this machine.** The operator caps local
   builders at three, because stacked `tsc`/test gates exhausted memory and
   rebooted the development machine on 2026-09-25 (a standing operator rule,
   recorded outside this repository). [inferred] A cloud stage uses none of
   this machine's memory while it runs; only the poll and the final `git
   apply` are local.
4. **The fragile part is isolated.** Submitting and fetching the diff go
   through the CLI, which OpenAI changes together with its backend. Only the
   view reads the internal endpoint. When the endpoint changes, the view
   says "conversation unavailable" and the stage still runs, finishes and
   hands over its diff.

Against (c): the whole thing is one client module, one transcript writer and
one stage executor, and the operator asked for it. Against (a) alone: it would
save the view slice, the smaller of the two, and give up the half the quote
names first.

### 3.3 How it maps onto Delegatus

**Accounts.** Environments belong to a ChatGPT account (1.2): A and B each
have their own set, C and D have none. A cloud task runs under whatever
account's `auth.json` the CLI reads, which Delegatus selects by setting
`CODEX_HOME` to that account's home, the same way it spawns local Codex
(`src/lib/accounts/manager.ts:21`). So the environment must be bound to an
account: the project records `{ account, environment }` (the environment by
its `owner/repo` label, which `exec` accepts), and a cloud stage runs on that
account only. If the named account has no such environment, the stage is
refused with the reason. It is never moved to another account. This matches
how a named stage account works today (`account` in
`src/lib/pipelines/types.ts`, #1279).

**Limits.** [inferred] A cloud task draws on the same Codex plan usage as a
local run on that account; the fetched documentation does not say, and usage
was not measured around the test task. The stage checks the account's
existing usage windows (`account_limits`) before submitting, like any
unattended launch. The first real use should compare the windows before and
after one task to confirm.

**Pipelines.** A run stage gains `placement: "cloud"`. It stays a Codex stage
(`engine: "codex"`), so the `Engine` union and every place that switches on
it stay unchanged; the OpenClaw design (`docs/design/openclaw-engine.md`)
shows how wide a new engine value spreads. The stage executor:

1. Resolves the lane's base on the remote: the merge base of the lane head
   with `origin/<default>`, which the cloud can check out. The lane's local
   commits beyond it become `CODEX_STARTING_DIFF` (the `pre_apply_patch` input,
   2.2), so nothing is pushed.
2. Runs `codex cloud exec --env <label> --branch <base branch> --attempts 1
   <stage prompt>` with the account's `CODEX_HOME`, and records the task id
   and URL on the stage attempt.
3. Polls `codex cloud list --json --env …` every 15–30 s (the record showed no
   partial progress, 2.4) until the task is `ready` or `error`, with a
   deadline.
4. On `ready`: reads the diff from the task record (or `codex cloud diff`),
   checks the turn's `base_commit_sha` against the base it sent, applies it in
   the lane worktree with `git apply --3way`, and the controller commits it as
   the stage's output, the way it records a read-only stage's declared outputs
   today.
5. Settles the stage itself. The cloud agent cannot reach the Viewer's MCP
   server, so it cannot call `stage_report`: completed with a diff that
   applies → `pass`; completed with no diff → `needs_decision` carrying the
   agent's final text; `error`, a conflict or a deadline → `fail` with the
   turn's `error.code`/`message`.
6. The next stage is the lane's normal local review. Cloud placement is for
   builder-style stages only. A review stage has to report findings through
   `stage_report`, so it stays local (Deferred).

**Spawns.** No local process is spawned. The stage attempt carries
`{ cloudTaskId, cloudTaskUrl, account, environment }` in place of a
conversation id, and the conversation it points at is the materialized cloud
transcript below.

**The feed (read-only view).** A small poller keeps a transcript file per
cloud task under a Delegatus-owned root, `statePath("codex-cloud", <account>,
<taskId>.jsonl)`, written in the rollout shape the reader already accepts:
the `thread/started` params become the session header (cwd, git info, model),
each `item/completed` becomes an `event_msg` with the item nested, and the
turn status becomes the conversation's state. The file is rewritten only
when the record changes, and only the `thread_events` items are kept. The rest
of the record (environment configuration, repository metadata, creator ids)
is never persisted. The root is registered next to the Codex session roots in
`src/lib/scanner/roots.ts`. The conversation is not deliverable: the composer
is disabled with "Runs in Codex Cloud — open in ChatGPT to follow up".

**Project attribution.** The environment's `repo_map` names the GitHub
repository, and that remote gives the `repo-<remote>` project key Delegatus
already computes (`src/lib/links/state.ts:66`, `src/lib/projects/identity.ts`).
The cloud `cwd` (`/workspace/<repo>`) is never used for grouping, since it
matches no local path.

**The board card and the task link.** The stage card shows the cloud glyph on
the Codex model line, the status from the task (`pending` / `ready` /
`error`), and a link to the task URL. The task link already opens the
conversation; for a cloud stage that conversation is the materialized
transcript. The ChatGPT task URL is stored on the attempt and shown as an
external link, and needs no new `WorkLinkKind` (those are for PRs and issues).

### 3.4 Failure modes

| Failure | What Delegatus sees | What it does |
|---|---|---|
| No environment for the repo on the bound account | `exec` fails: `environment '…' not found` [source] | refuse the stage, naming the account and the missing environment |
| Account logged out or token expired | CLI: "Not signed in"; backend: 401 | the account's existing login health; stage `fail` |
| Task fails or is cancelled in the web page | `turn_status failed/cancelled`, `turn.error` | stage `fail` with the error text |
| Completed with no change | `diff` exits 1 "may still be running" (2.7) | read status first; `needs_decision` with the final text |
| Diff does not apply on the lane | `git apply --3way` conflict | stage `fail`; the diff is kept on the attempt |
| Branch or base missing on the remote | the cloud cannot check it out | resolve the remote merge base before submitting |
| Cloud toolchain differs (Bun 1.2.14 default) | tests the agent ran in the cloud prove little | review and gates stay local; environment setup pins Bun 1.4.0 |
| Task hangs | status stays `pending` | stage deadline → `fail`; the task is left for the operator to cancel on the web |
| Cloudflare starts challenging Bun's fetch | 403 HTML from the backend | fall back to `curl` with the token on stdin, as `transcribe/chatgpt.ts` does |
| Record is large (983 KB seen) | slow polls | poll the cheap `list` until terminal, then fetch the record once |
| The CLI writes `error.log` into its working directory | **[observed]** `codex cloud list` run in a checkout left an untracked `error.log` there, with the base URL, the auth mode and the ChatGPT account id | run every `codex cloud` command with its cwd in a private scratch directory, never the lane worktree, so the file cannot be committed or read by a stage |

### 3.5 What breaks if the internal backend changes

- **Envelope moved or renamed** (`thread_events`, `current_assistant_turn`):
  the view shows "conversation unavailable" with the task URL. Launch,
  status, diff and stage settlement continue through the CLI.
- **Status display fields renamed:** only the view's status text is affected;
  the stage reads status from `codex cloud list --json`.
- **Diff location moved:** the executor falls back to `codex cloud diff`,
  which OpenAI keeps working with its own backend.
- **Path style switch** (`/wham` → `/api/codex`): one base-URL constant, the
  same switch the CLI makes.
- **The CLI's `cloud` commands removed or changed** (they are
  `[EXPERIMENTAL]`): the stage stops working. Detect it with one
  `codex cloud --help` probe at startup, and hide cloud placement when it
  fails.

---

## 4. Slice plan

Sizes are estimates of added lines, tests included. Every test file is run by
path, never by sweeping a directory against live state (AGENTS.md).

### Slice 1: cloud client (~350 lines)

- `src/lib/codexCloud/client.ts`: `listEnvironments(account)`,
  `listTasks(account, env?)`, `getTask(account, id)`, `submit(account, {env,
  branch, prompt, startingDiff})`. `submit` and `listTasks` run the CLI with
  the account's `CODEX_HOME` and a private scratch cwd (the CLI's `error.log`
  lands there, 3.4); `getTask` and `listEnvironments` read the backend
  with the account's token, never logged. Loose parsing: every field optional.
- `src/lib/codexCloud/types.ts`: the task record subset used (status, turn
  error, diff, thread events, base commit).
- `src/lib/codexCloud/client.test.ts` with fixtures in
  `src/lib/codexCloud/fixtures/`, built from the shapes in section 2 with
  invented ids: pending record, completed-without-diff, completed-with-`pr`,
  failed turn, unknown envelope.

### Slice 2: read-only view (~450 lines)

- `src/lib/codexCloud/transcript.ts`: a task record → rollout-shaped JSONL
  lines (`item/completed` → `event_msg` with the item nested; `thread/started`
  → session header; turn status → state).
- `src/lib/codexCloud/poller.ts`: keeps each tracked task's file current;
  polls `list` until terminal, then fetches the record once.
- `src/lib/scanner/roots.ts`: register the `codex-cloud` root.
- Project attribution from the environment's repository remote, with a
  `describe.test.ts` case so a cloud task groups under its repository's
  project.
- Tests: `transcript.test.ts` feeds the output through the real
  `normalizeSessionLine` (`src/lib/session/reader.ts`) and asserts the feed
  records: one `commandExecution` with its output and exit code, the final
  `agentMessage`, the user prompt. Rendered evidence goes through the existing
  phone and board drivers named in AGENTS.md; no new driver.

### Slice 3: cloud placement for run stages (~600 lines)

- `src/lib/pipelines/types.ts` and `validation.ts`: `placement?: "cloud"` on
  run stages, refused on review stages and when the project has no bound cloud
  environment.
- Project binding `{ account, environment }` beside
  `src/lib/accounts/projectBindings.ts`.
- `src/lib/pipelines/cloudStage.ts`: the executor in 3.3, steps 1–5.
- The stage-start branch in `src/lib/pipelines/engine.ts` that hands a cloud
  stage to the executor where a local stage would spawn.
- Board card: cloud glyph, status and task link on the stage row.
- Tests: `cloudStage.test.ts` against a stub CLI on `PATH` and a stub backend
  on port 0, covering pass with a diff, no diff → `needs_decision`, failed
  turn → `fail`, conflicting diff → `fail`, deadline → `fail`, account without
  the environment → refused.

---

## 5. What the operator must set up

Delegatus cannot run a cloud task on this repository until an environment
exists for it. That is a one-time step the operator takes on the ChatGPT Codex
page:

1. Pick the account. **Recommendation: account A**, the default Codex account.
   It already has a GitHub connection and working environments, and it has the
   largest plan of the four. Account B also has a GitHub connection. Accounts
   C and D would need GitHub connected first.
2. Create an environment for `Latand/delegatus`, with a setup script that
   installs Bun 1.4.0 (the `Dockerfile` pin) and runs
   `bun install --frozen-lockfile`.
3. Keep network access on with the default `codex` allowlist.

The design stands without it. Slice 3's first real run needs it; slices 1
and 2 can be built and verified against the operator's existing environments.

---

## Deferred — not currently justified

- **Live streaming of a running task.** Not available: the task record did
  not change while the task ran (2.4). Revisit if a long task shows partial
  events or a documented stream appears.
- **Follow-up messages into a cloud task.** No CLI command and no endpoint in
  the CLI source. The composer stays disabled with a link to the web page.
- **Opening PRs from the cloud.** No CLI or backend-client call exists, and our
  merge path already runs through the lane's own PR after local review.
- **Best-of-N attempts** (`--attempts N`, `sibling_turns`). Only useful once
  one attempt proves worth its usage; review of N diffs is an operator cost.
- **Cloud review stages.** A reviewer must report through `stage_report`, which
  the cloud agent cannot reach.
- **Creating or editing environments from Delegatus.** A one-time operator
  step (section 5); automating it means writing to account configuration.
- **Setup-script log contents** (`file_…` pointers). The endpoint is unknown,
  and the logs only matter when setup fails, which the turn error already
  reports.
- **Cancelling a task from Delegatus.** No CLI command. A stage deadline marks
  the stage failed and leaves the cloud task to the operator.
- **Importing every cloud task of every account into the feed.** Slice 2
  tracks tasks Delegatus launched plus ones the operator attaches by URL. A
  full import of the private history is not asked for.
