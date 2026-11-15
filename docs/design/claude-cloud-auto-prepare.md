# Claude Cloud prepares its scheduled task on every account by itself

Status: design, 2026-11-12. Written from `main` at `cb408fce` (`origin/main` at
`15099450` changes none of the files cited here). Builds on
`docs/design/claude-code-cloud.md` (§1.13, §1.14, §4.4) and on the Codex Cloud
automatic preparation already on `main`.

## Policy update — 2026-11-12, about 15:55 UTC

The operator permits a GitHub connection with write access. That capability
has no readiness penalty, human remedy or local fallback in this design.
Preparation never reads the old probe or hold artifacts. A separate execution
policy lane removes the legacy write probe and six-hour hold; this lane keeps
that code with its owner.

Agents and the designated seat record bindings through automatic admission and
`claude_cloud_task prepare`. The operator only completes identity-bound GitHub
connection or environment setup, when required. No console or manual binding
step is part of the workflow.


## Implementation

The preparation slice and revision claims live in
`src/lib/projects/claudeCloudTasks.ts`. Admission first queues the allowed pool
before execution-capacity selection, then calls that slice through
`cloudClaudeClient.ts`; `setClaudeCloudTaskFor` preserves sibling and predecessor
bindings. A known creation or discovery id is persisted before repair and read
again after restart, even if the list has not caught up. The per-account task fingerprint remains the execution guard, while
the whole task list no longer participates in the shared lane fence.

The previous saved prompt remains an ownership marker by its normalized SHA-256,
so a renamed existing routine is adopted after the policy update. New tasks
receive only the current prompt.

Readiness is API-only: settings GET includes `claudeCloudReadiness`, and MCP
`claude_cloud_task` reads readiness or queues `prepare` through
`/api/projects/claude-cloud-tasks`. The Viewer owns one sequential queue, capped
at 256 project/account pairs with a ten-minute execution deadline per pair.
Preparation rechecks the project pool, repository and account home; provider
calls also fence the organization after reading the current subscription login.
Human-only steps are translated when readiness is read. Inline validation reads
both the bound task and its GitHub connection and records the validation in the
readiness row. The demand queue validates allowed accounts separately; no
performance gain is claimed.

Claude uses the existing fallback record. The companion runtime-visibility
lane consumes that record through its shared projection; this implementation
adds no separate visibility mechanism.


## Originating requirement

Operator, 2026-11-12 about 13:21 UTC, answer on the decision form about Claude
Cloud setup (paraphrased, because this document is public): an agent creates the
scheduled task through the API on the main account and records its id; this
holds for every account, and an agent must always help set this up.

The pinned task turns that into four acceptance criteria:

1. For each Claude account of a project whose repository is on GitHub, Delegatus
   prepares Claude Cloud automatically. It finds an existing task first, because
   tasks cannot be deleted through the API, so preparation is idempotent and
   never creates a duplicate. It creates the task with the saved prompt, removes
   the default connectors, and records the id in `claudeCloudTasks` without
   replacing other entries.
2. Readiness is visible per account, the way `codex_cloud_environment` shows it:
   ready, or unavailable with the exact reason. An account that needs a
   human-only step (GitHub not connected, no environment) names that step
   plainly in the operator's language, as one action with its link. Nothing else
   is asked of the human.
3. When preparation is impossible, a stage that requests `claude-cloud` says so
   at admission and does not fall back silently. It shares one mechanism with
   lane ccda75f5 (Codex Cloud 409 and fallback visibility).
4. Tests use provider fakes; one real probe on one account is allowed and
   recorded; each lifecycle test file runs in its own isolated gate-slot command;
   the MCP surface is proved through a real MCP SDK client over the real server
   on port 0; typecheck, lint and privacy pass; no account names, ids, org ids or
   tokens appear in public text.

## What the one-time setup agent found, 2026-11-12 13:24–13:32 UTC

A spawned agent did this install's setup by hand on the three Claude accounts.
Its report sits in that agent's private evidence directory; the task ids and
environment ids it names stay there. In this document the accounts are the
**main account**, the **S0 account** (account A of `claude-code-cloud.md`
§1.14) and the
**third account**.

| Account | Task | GitHub | Environment | Connectors |
| --- | --- | --- | --- | --- |
| main | one task named `Delegatus pipeline stages`, created 2026-11-11 through the CLI's own `RemoteTrigger`, enabled, one-off run a year ahead | connected, `auth_source: oauth` | one `anthropic_cloud` environment named Default | 0 |
| S0 | one task with the same name, created 2026-11-01, paused on 2026-11-11 by an earlier operator decision; the agent re-enabled it at 13:30:43 with `POST /v1/code/triggers/{id}` and body `{"enabled": true}` (200) | connected, `oauth` | Default | 0 |
| third | none: `POST /v1/code/triggers` answered **401** with `error.reason: "github_token_missing"` twice; a list afterwards was empty | not connected (`is_authenticated: false`) | Default | — |

Both existing tasks have exactly one source (this repository), model
`claude-opus-5-5`, tools Bash, Read, Write, Edit, Glob and Grep, and a saved
prompt equal to `docs/cloud/claude-task-prompt.md` with whitespace normalized.
The real `prepareEnvironment` from `main`, run in an isolated state directory
with a candidate binding, answered ready for the main and S0 accounts.

The agent could not record the binding:

- an anonymous request to `PUT /api/projects/settings` is refused by the
  workspace gate with 401 `member_required` (`src/lib/team/workspaceRoute.ts:271`);
- a request carrying an agent capability reaches
  `src/app/api/projects/settings/route.ts:218-221`, where
  `requireOperatorAuthority` (`src/lib/agent/operatorAuthority.ts:140-141`)
  returns `AGENT_REFUSED` (`:53-57`) for any caller conversation.

So the five points the brief lists are facts on this install: (a) no agent can
write `claudeCloudTasks`; (b) creating a task on an account without GitHub
answers 401 `github_token_missing`; (c) an existing task can be paused;
(d) the old execution restriction is withdrawn by the policy update above; (e) two tasks already exist and must be adopted.

## Historical baseline before automatic preparation

### Claude admission

`createClaudeCloudStageClient().prepareEnvironment`
(`src/lib/pipelines/cloudClaudeClient.ts:415-440`) is read-only:

- `:417-418` reads the account's task from `claudeCloudTasks` and refuses with
  "no Claude cloud scheduled task is set for this account";
- `:423-433` reads `GET /v1/code/triggers/{id}` and refuses a paused task, any
  connector, or a different repository;
- `:438-439` answers ready with `selection: claudeCloudTaskFingerprint(...)`.

Every request goes through `request()` (`:203-212`) on the account's own
subscription login (`login()`, `:193-201`). `read()` maps any 401 to "Claude
Cloud login was refused" (`:221`), and `startRun` does the same for the run
call (`:313`). A 401 whose body says `github_token_missing` would therefore be
reported as a refused login.

### Settings

`claudeCloudTasks` is `Array<{accountId, taskId}>`
(`src/lib/projects/settings.ts:81-82`, validator `:218-224`). The reader takes
the canonical key, then predecessor keys in order, and the first defined value
wins (`:227-235`). `setClaudeCloudTasks` replaces the whole list on the
canonical key (`:242-251`). Its only writer is the operator-only PUT
(`route.ts:218-221`, `:271`).

### The Codex automatic-preparation path

- **Contract.** `CloudStageClient.prepareEnvironment`
  (`src/lib/pipelines/cloudStage.ts:87`) with input
  `PrepareCloudEnvironmentInput` and result `ready | pending | unavailable`
  (`src/lib/projects/codexCloudEnvironments.ts:207-214`).
- **Engine admission.** For each candidate account the engine calls
  `prepareEnvironment`, collects `ready` accounts, waits on `pending`, and joins
  each `unavailable` reason as `Account <id>: <reason>`
  (`src/lib/pipelines/engine.ts:9352-9386`). With no eligible account it throws
  `HostedCloudError(reasons, "cloud-limit")` (`:9385-9386`).
- **Preparation slice.** `prepareCloudEnvironment`
  (`codexCloudEnvironments.ts:218-386`): a persisted binding per project,
  account, repository and ref in the `codex_cloud_environments` collection of
  `state.sqlite` (`:25-44`), alias-aware keys (`:53-58`), writes under an
  expected revision (`:70-88`), a creation claim persisted before the POST and
  released only by a confirmed refusal (`:311-327`, `:89-105`), and a bounded
  retry window: three failures with two and four seconds between them inside ten
  minutes, then a fifteen-minute cooldown (`:241-245`, `:376-384`). Reasons are a
  fixed table (`src/lib/pipelines/cloudEnvironmentClient.ts:11-24`).
- **Inline at admission.** The Codex client's `prepareEnvironment` runs that
  slice and then raises a demand (`src/lib/pipelines/cloudHostedClient.ts:390-395`).
- **Background walk.** `CloudEnvironmentController`
  (`src/lib/projects/cloudEnvironmentController.ts:72-259`) walks every scanned
  project with a GitHub remote times every Codex account, and serves demands
  (`src/lib/projects/cloudEnvironmentDemand.ts:13-25`).
- **Agent surface.** MCP `codex_cloud_environment` reads bindings without
  contacting the provider and lets the operator or the project's designated
  seat set an override (`src/lib/mcp/bindings.ts:8865-8874`; authority
  `:4830-4838`; route `src/app/api/projects/cloud-environments/route.ts:29-44`;
  route-side authority `src/lib/projects/cloudEnvironmentAuthority.ts:10-20`).
  The settings GET also returns the bindings (`route.ts:113`). No UI component
  renders them.

### Fallback and its visibility

A `cloud-limit` refusal before submission marks the attempt
`fallbackEligible` (`engine.ts:9509-9525`); the next tick calls `fallback()`
(`:9686`), which records `attempt.cloud.fallback = {at, reason}`, sets
`executionRuntime: "cloud-then-local"` and writes
`stateDetail = "<label> fallback to local: <reason>"` (`:9625-9643`). The board
already shows "moved local" with the reason through
`src/components/kanban/stageIdentity.ts:73-78`. Lane ccda75f5 found that compact
reads drop the actual runtime and the reason; it is adding them for Codex. Today
lane c63c21f9 shows the Claude case: its `stateDetail` reads "Claude Cloud
fallback to local: Account …: no Claude cloud scheduled task is set for this
account; …" until the local run overwrites it.

### A fence that a background writer would trip

Before a task id exists, a Claude attempt's job authority includes the whole
`claudeCloudTasks` list (`cloudTargetChoice`, `engine.ts:9535-9537`, used by
`cloudExecutionFence`, `:9543-9551`, compared in `sameCloudIntent`, `:9553-9557`).
A write of account B's entry while account A's attempt is in `submitting`
therefore withdraws A's job, and the next tick rejects it as "submission was
interrupted; outcome unknown" and parks the lane (`:9714`). Today only the
operator writes that list, so this never fired. Preparation adds a second
writer.

## Design

### 1. Which projects and accounts are prepared

Preparation runs in two places:

- at the admission of a `claude-cloud` stage, before selecting execution candidates
  by quota: every allowed account, resolved with `requireCapacity: false`, including
  accounts without execution capacity and siblings of a pinned execution account;
- when the operator or the project's designated seat calls the `prepare` action
  (§6): every allowed account with a claude.ai login, or the one named.

An account takes part only when it is allowed for the project
(`projectAllowsAccount(project, "claude", id)`,
`src/lib/accounts/projectBindings.ts:571-579`). Removing an account from the
project's Claude pool is the off switch.

Recommendation and trade-off: the Codex controller walks every scanned GitHub
project. Applied to Claude, that walk would create one scheduled task per
account for every GitHub project the user ever opened, on claude.ai, where the
API cannot delete them. Preparing on use gives every account of every project
that uses Claude Cloud a task with no human step, and creates nothing for
projects that never asked. Widening later means running the Codex controller
with a Claude port (see Deferred); narrowing after tasks exist is impossible.

### 2. The preparation slice

New module `src/lib/projects/claudeCloudTasks.ts`, the Claude counterpart of
`codexCloudEnvironments.ts`. One exported function,
`prepareClaudeCloudTask(input: PrepareCloudEnvironmentInput, provider)`,
returns the existing `CloudEnvironmentPreparation` type. One call is one slice
for one project and account. Steps, in order; each step that contacts the
provider is preceded by `guard()` (signal, `assertCurrent`, and an unchanged
account home and organization digest):

1. **Login.** Reuse `login()` (`cloudClaudeClient.ts:193-201`). Third-party
   provider, missing login and expired login end the slice with their reasons;
   nothing is sent.
2. **Row.** Read the account's readiness row (§3). An organization digest that
   differs from the login's resets the row to `preparing` and drops its creation
   receipt, since tasks belong to an organization. At admission, an
   `unavailable` row inside its cooldown answers its stored reason at once, so a
   stuck account costs no request per stage. The seat's `prepare` (§6) is an
   explicit request and starts a new window; that is how a human step that was
   just done gets noticed. Ordinary admission demands preserve the stored cooldown.
   Explicit background preparation rechecks its caller’s authority before each
   provider operation, including after an asynchronous wait.
3. **Bound task.** When `claudeCloudTasks` names a task for the account, read it
   (`GET /v1/code/triggers/{id}`, envelope `{trigger}`, §1.14 O27).
   - 404, or one source that is a different repository: continue at step 4, and
     the binding may be replaced for this account only (§5).
   - Otherwise **fix** it (below) and answer ready.
4. **Find first.** List the account's tasks (`GET /v1/code/triggers`, answer
   `{data, has_more}`). `has_more: true` ends the slice with
   `task_list_incomplete`, so a task on a later page can never be missed and
   duplicated. A task is Delegatus's for this project when its
   `job_config.ccr.session_context.sources` holds exactly one
   `git_repository.url` equal to the project's repository (same normalisation as
   `normalizedGithubUrl`, `cloudClaudeClient.ts:127-131`) and either its name is
   `Delegatus pipeline stages` or its saved prompt equals the shipped prompt with
   whitespace normalized. Among several, take an enabled one, then the oldest
   `created_at`. Found: fix it, bind it (§5), answer ready. Tasks of other
   repositories and tasks that match neither marker are never read further or
   changed.
5. **Earlier creation.** A row whose creation claim has no recorded answer
   (§2.1) never creates again while the claim stands. A claim younger than one
   minute (the POST's own 20-second deadline plus margin) answers `pending`, so
   a concurrent stage waits two seconds for the holder; an older one answers
   `create_uncertain` and is settled by the lists of §2.1.
6. **GitHub.** `GET /api/oauth/organizations/{org}/sync/github/auth` (O5; the
   call behind the CLI's connection status). `is_authenticated: false` ends the
   slice with `github_not_connected` and its step (§7). An unreadable answer
   continues: the creation's own 401 is authoritative.
7. **Environment.** `GET /v1/environment_providers` with
   `anthropic-beta: ccr-byoc-2025-07-29` (the header S0 used). Rows carry
   `environment_id`, `name`, `kind`, `state`. Choose the active
   `anthropic_cloud` row named Default, else the first active one. None:
   `no_environment` and its step.
8. **Create.** Claim (§2.1), then `POST /v1/code/triggers` with the body of
   the 2026-11-11 creation: `name: "Delegatus pipeline stages"`,
   `run_once_at` one year ahead at 12:00 UTC, `enabled: true`,
   `clear_mcp_connections: true`, `job_config.ccr.environment_id`,
   `session_context.model` (the catalogue id the `opus` alias resolves to;
   `/model` sets each stage's own model, O23), one `git_repository` source,
   `allowed_tools: ["Bash","Read","Write","Edit","Glob","Grep"]`, and one `user`
   event whose content is the shipped prompt with paragraphs joined.
   - 200 with an id: record the id on the row, then fix and bind.
   - 401 with `error.reason: "github_token_missing"`: release the claim,
     `github_not_connected`.
   - Any other 4xx with an error body: release the claim, `create_refused` with
     the status.
   - A timeout, reset, 5xx or unreadable 2xx: keep the claim,
     `create_uncertain`.

**Fix** a found or bound task: `enabled: false` → `POST
/v1/code/triggers/{id}` with `{"enabled": true}` (observed 2026-11-12); any
entry in `mcp_connections` or `session_context.mcp_connector_ids` → the same
call with `{"clear_mcp_connections": true}` (observed 2026-11-01 and
2026-11-11). The update answers the trigger; the slice checks the answer the way
admission checks a read today (`cloudClaudeClient.ts:425-433`) and answers ready
only when it shows enabled, zero connectors and one source equal to the
repository. A refused update ends with `update_refused` and its status.

**Transient answers** (429, 5xx, a connection that never opened) anywhere count
one failure in the Codex window (three failures at 2 s and 4 s inside ten
minutes, then 15 minutes). Inside the window the slice answers `pending` with
`retryAt`; after it, `unavailable` with `provider_unavailable`.

**A 401 carrying `github_token_missing`** maps to `github_not_connected` in
every Claude call, the run call included. A shared helper replaces the bare 401
mappings at `cloudClaudeClient.ts:221` and `:313`; other 401s keep "login was
refused".

#### 2.1 No duplicate, ever

The creation follows the Codex claim (`codexCloudEnvironments.ts:311-327`):

- The claim `create: {intent, dispatchedAt}` is written under the row's expected
  revision **before** the POST. A second preparer (another lane's admission, the
  seat's `prepare`) that loses the revision race answers `pending` and lists
  again two seconds later; only the claim holder sends a POST.
- Only a confirmed refusal (a 4xx with an error body) releases the claim, under
  the same keyed write the Codex path uses for its marker (`:89-105`).
- An unanswered claim is settled by listing. A matching task found by step 4 is
  adopted and bound. The claim is released without a match only after two
  complete lists taken at least ten minutes after `dispatchedAt` both show no
  matching task; the release is recorded on the row. The residual risk is a task
  the API created and still hides from its own list ten minutes later. Two
  observations argue against it: the list showed the new task at once on
  2026-11-11, and was empty right after the refused creations on 2026-11-12.

### 3. The readiness record

A new collection `claude_cloud_tasks` in `state.sqlite`, built the way
`codex_cloud_environments` is (`codexCloudEnvironments.ts:39-92`): the same
`SqliteStateCollection` with `strictDecode`, alias-aware keys
`<sha256(project key)>!<accountId>`, writes under an expected revision, and a
collection revision for cheap change checks. Seed `schemaVersion: 1`,
`migrationId: "claude-cloud-tasks-v1"`, no records loaded. The store holds no
credential and no organization id in clear.

```
{ key, project, accountId, repository,
  organization: sha256 | null,
  taskId: string | null,          // the task this row last proved
  state: "preparing" | "ready" | "unavailable",
  code: ClaudeTaskReason | null,
  validatedAt: number | null, retryAt: number, deadlineAt: number,
  retries: 0..3, revision: number,
  create: { intent, dispatchedAt?, listsAfterDispatch?, releasedAt? } }
```

`ClaudeTaskReason`, a fixed table beside the Codex one:

| Code | English reason (engine, MCP, fallback) | Step |
| --- | --- | --- |
| `login_missing` | the account's claude.ai sign-in is missing on this machine | — |
| `login_expired` | the account's claude.ai sign-in expired; it refreshes on the account's next local run | — |
| `third_party_provider` | this account uses a third-party provider; Claude Cloud needs a claude.ai subscription | — |
| `github_not_connected` | GitHub is not connected to this Claude account | `connect_github` |
| `no_environment` | this Claude account has no cloud environment | `create_environment` |
| `task_list_incomplete` | the account's task list has a further page that Delegatus does not read; nothing was created | — |
| `create_uncertain` | a task creation may have succeeded; Delegatus is reconciling and creates no other | — |
| `create_refused` | Claude Cloud refused the task creation (status) | — |
| `update_refused` | Claude Cloud refused to enable the task or clear its connectors (status) | — |
| `provider_unavailable` | Claude Cloud could not be reached or answered with an error | — |
| `binding_busy` | project settings were busy; the binding is retried | — |

### 4. Stage admission (acceptance 3)

The Claude client's `prepareEnvironment` becomes the Codex shape: run one slice
inline and return its preparation result.

```
prepareEnvironment(input):
  prepared = prepareClaudeCloudTask(input, provider)   // §2
  if prepared is not ready: return prepared            // pending or unavailable, with the table's reason and step URL
  return ready { environmentId: taskId, selection: claudeCloudTaskFingerprint(project, account), revision, principal }
```

The engine admission loop (`engine.ts:9352-9386`) stays unchanged: it already
calls `prepareEnvironment` for every candidate account, waits on `pending`, and
joins each account's reason. When no account is ready the joined reasons go
through `fallback()` (`:9625-9643`) into `attempt.cloud.fallback.reason`,
`executionRuntime` and `stateDetail`. An account that needs a human step adds
the step's URL to its reason, for example `Account <id>: GitHub is not
connected to this Claude account; connect it at
https://claude.ai/connect-github`.

That is the whole of acceptance 3 on the Claude side: the stage says at
admission which account failed and why, and the existing shared fallback records
it. The fallback itself stays, as the operator decided on 2026-10-24 and 2026-10-25
(retry, confirm, then run locally once). This lane builds no visibility code of
its own (§9).

Cost on the hot path: an account with a usable bound task costs one `GET` per
admission, plus local reads of the row and settings cache and a readiness
validation write. Discovery, environment and GitHub reads happen only for an account
without a usable binding. A cooldown answers without any request.

### 5. Writing `claudeCloudTasks` and the fence

New `setClaudeCloudTaskFor(project, accountId, taskId, replacing: string | null)`
in `settings.ts`, inside the existing `underFileLock` (`:327-330`, which
invalidates the cache, so reads inside it are fresh):

- read the effective list with `claudeCloudTasks(project)`, so entries that live
  under a predecessor key are carried into the canonical key and kept;
- when the account has no entry, append `{accountId, taskId}`;
- when it has one, replace it only if its task id equals `replacing` (the task
  step 3 proved missing or foreign); otherwise leave it and answer the stored
  value;
- every other account's entry is copied unchanged; a busy lock answers
  `binding_busy`, which the slice reports as `pending`.

The operator's PUT keeps replacing the whole list. If it drops an account whose
task still exists, the next slice adopts that task again; to stop an account,
the operator removes it from the project's Claude pool.

**Fence fix.** `cloudTargetChoice` (`engine.ts:9535-9537`) returns a constant
for `claude-cloud`. The per-account fence already exists and stays:
`cloud.environmentSelection` is set from the ready answer (`:9395`) and checked
before every remote effect (`:9322-9323`) and on every tick (`:9652-9653`). An
edit of the attempt's own account still stops it before its next effect; an
edit of another account no longer withdraws it. Codex keeps its project-wide
choice in the fence.

The fix is also what lets admission prepare inline. Without it, the admission
loop's own first binding changes the list it is fenced on, the job withdraws
itself at its next guard, and every newly bound account costs one more tick
before any stage starts.

### 6. The agent path and the operator consent it needs (point a)

Automatic preparation (§4) is the main writer: it runs in the Viewer process for
a stage the operator or seat put on a lane, and needs no agent to write
anything. For everything else there is one new MCP tool beside
`codex_cloud_environment`:

`claude_cloud_task`

- `read {project, accountId?, after?, limit?}`: one projection per allowed
  Claude account (§7), from the store and settings. It
  contacts no provider. Without `clientRequestId` it is receipt-free, like the
  Codex read (`server.ts:2935`).
- `prepare {project, accountId?, clientRequestId}`: asks for one slice for the
  named account, or for every allowed account with a login, and answers at once
  with the projections, the asked accounts reading `preparing`. The slices run
  after the answer. A loopback POST from the MCP server gets five seconds per
  attempt (`CONTROL_ATTEMPT_TIMEOUT_MS`, `bindings.ts:373`, applied at `:463`)
  and is retried after that, so a route that waited on the provider would be
  re-entered while it still ran. The route therefore hands the pairs to a small
  in-process queue in the Viewer: one slice per pair at a time, pairs one after
  another, each under a 60-second deadline inside
  `withViewerOperation("cloud.claude-task-preparation")`. A second ask for a
  pair already queued or running joins it. This is the Codex demand
  (`cloudEnvironmentDemand.ts:13-25`) without the walk around it, kept in its
  own store: the Codex controller takes every demand from its queue
  (`cloudEnvironmentController.ts:146-156`), and account ids such as the main
  account's repeat across engines. The seat reads
  the outcome with `read`. A replay with the same key answers the recorded
  result and queues nothing.

Wiring copies `codex_cloud_environment` line for line: binding as in
`bindings.ts:8865-8874` posting to a new route
`/api/projects/claude-cloud-tasks` (GET read, POST prepare) shaped like
`cloud-environments/route.ts`; tool lists `server.ts:147` and `:231`; description
and schema beside `:4058` and `:4993-4996`; mutating read fields beside
`toolAllowlist.ts:251`. The settings GET adds `claudeCloudReadiness` next to
`codexCloudEnvironments` (`route.ts:113`); the PUT is unchanged.

**Authority.** `prepare` uses the Codex gate unchanged: in the MCP binding
`cloudEnvironmentWriteAuthority` (`bindings.ts:4830-4838`, refusal code
`claude_cloud_task_write_refused`, 403), and in the route `cloudEnvironmentActor`
(`cloudEnvironmentAuthority.ts:10-20`), rechecked right before the pairs are
queued, as `cloud-environments/route.ts:38-40` rechecks before its write. The
operator, the root conversation and the project's designated seat may call it;
any other agent is refused. A queued slice outlives its request, so its
`assertCurrent` rechecks what the Codex controller rechecks for its own slices
(`cloudEnvironmentController.ts:241-245`): the account is still allowed for the
project and resolves to the same home, and the project's GitHub repository is
unchanged.

**Consent.**

- For this install: the operator's answer of 2026-11-12 13:21 UTC asked for
  exactly this on every account. No further form is needed.
- For every Delegatus user: the operator's designation of a seat is the consent
  for that seat to call `prepare`, as it already is for Codex overrides. A
  project's use of a `claude-cloud` stage is the consent for admission to
  prepare its allowed accounts. The account pool is the per-account consent and
  the off switch.
- What preparation and the agent path never do: start a session or a run, change
  a GitHub connection, touch a task of another repository or a task that is not
  Delegatus's, use the operator's browser session, or call the settings PUT.
- What stays behind after withdrawal: tasks already created remain on claude.ai,
  because the API cannot delete them. Each is inert: its only scheduled run is a
  year ahead, and its saved prompt makes any run without an assignment end at once.

### 7. Readiness projection and the human steps (point b)

```
{ project, accountId, label,
  state: "not_prepared" | "preparing" | "ready" | "unavailable",
  code, reason,                                  // English, from the table
  step: null | { code, text, url },              // text in the operator's language
  taskId,
  validatedAt, retryAt, revision }
```

`not_prepared` is an allowed account with no row yet. `step.text` is rendered at
read time with `translate(operatorLocale() ?? "en", key)`
(`src/lib/operator/settings.ts:105`), keys in `src/lib/i18n/en.ts` and `uk.ts`.
Each human-only cause has exactly one step:

| Step | Link | en | uk |
| --- | --- | --- | --- |
| `connect_github` | `https://claude.ai/connect-github` | Connect GitHub to this Claude account on claude.ai. | Підключіть GitHub до цього акаунта Claude на claude.ai. |
| `create_environment` | `https://claude.ai/code/onboarding?magic=env-setup` | Create a cloud environment for this Claude account on claude.ai. | Створіть хмарне середовище для цього акаунта Claude на claude.ai. |

Sources of the links: the installed CLI prints `${CLAUDE_AI_ORIGIN}/connect-github`
when GitHub is not connected and names `…/code/onboarding?magic=env-setup` for
environment setup (read from the CLI binary on 2026-11-12).

The readiness answers acceptance 2 through the seat: the seat reads
`claude_cloud_task`, relays each `step.text` with its link to the operator in
the operator's language, and calls `prepare` once the operator says the step is
done. Nothing else reaches the human.

### 8. Hostile cases walked through the design

| Case | Path | Outcome |
| --- | --- | --- |
| Two lanes admit `claude-cloud` on the same project at once; no task exists | both slices list, both reach step 8 | one wins the claim revision and POSTs; the other answers `pending` and adopts the created task on its next slice |
| The creation times out after the request was written | claim kept | `create_uncertain`; the next lists adopt the task when it is there; no second POST until two complete lists ten minutes later show none |
| The account's GitHub is not connected | step 6, or the creation's 401 | `github_not_connected` with its step; the claim is released; the login is not marked refused |
| The S0 account's task is paused | step 4 or 3 | enabled with one update; no creation |
| A Delegatus task gained a connector | fix | cleared with one update before ready |
| The user has their own routine on the same repository | step 4 markers | neither name nor prompt matches; never read further or changed; a Delegatus task is created beside it |
| The list has a second page | step 4 | `task_list_incomplete`; nothing created |
| Preparation binds account B while account A's attempt is submitting | §5 fence fix | A's job continues; B's entry is the only change |
| The operator's PUT and a slice's upsert race | settings file lock | last writer wins inside the lock; a dropped automatic entry returns on the next slice |
| The project's entries live under a predecessor key | upsert reads the effective list | all entries move to the canonical key with the new one |
| A different claude.ai login is signed into the same account home | organization digest | the row resets; the bound task answers 404 on the new login and is replaced for this account only |
| The bound task was set by hand to another repository | step 3 | the account is rebound to a Delegatus task of this repository; the old task is left as it is |
| The connection can write | ordinary preparation | `ready`; no permission-change remedy |
| A worker agent calls `prepare` | MCP authority | 403 `claude_cloud_task_write_refused`; the route refuses as well |
| The MCP server retries a `prepare` POST after its five-second attempt deadline | route queue | the retry joins the queued pair; one slice runs |

### 9. One mechanism with lane ccda75f5

Lane ccda75f5 makes the actual runtime and the fallback cause visible. Its
uncommitted build diff, read at 2026-11-12 13:57 UTC (24 files, unreviewed),
does it in one place for both runtimes:

- `stageExecution(stage, attempt)` in `cloudStage.ts` answers
  `{requestedRuntime, executionRuntime, reason}` from
  `attempt.definition.runtime`, `executionRuntime`, `cloud.taskId` and
  `cloud.fallback.reason`; it reads `claude-cloud` the same way as
  `codex-cloud`;
- `listProjection.ts` puts that answer on every compact stage row, with the
  reason passed through `clampText`;
- `attemptPlace` in `stageIdentity.ts` reads the same fields for the board.

That projection is the one mechanism. This design adds no field, projection or
copy to it; Claude admission writes its reason through the existing
`fallback()` (`engine.ts:9625-9643`), and the projection shows it. Because
compact rows clamp the reason, each account's part of a Claude reason stays
short (`Account <id>: <reason>; <step URL>`), and the whole text stays on the
attempt record and in the readiness read.

The same draft changes policy for Codex only: `fallback()` begins with
`if (runtime === "codex-cloud") return reject(...)`, so a Codex stage parks with
"Codex Cloud required; Cloud execution failed: <reason>. Select runtime local
explicitly to run on this machine." This design keeps Claude on the visible
fallback, which is what the operator decided on 2026-10-24 and 2026-10-25 and
what acceptance 3 asks ("does not fall back silently"). Both policies live in
that one function, so if the operator wants Claude stages to park the way Codex
stages would, the change is that one condition widened to every cloud runtime.
The seat should carry this point to ccda75f5's review.

Shared files, checked with `git merge-file` on scratch copies of `cb408fce`,
this design's `cloudTargetChoice` edit and ccda75f5's working `engine.ts`: no
line conflict (ccda75f5 edits `:9288-9420`, `:9506-9523`, `:9640` and the
create and patch paths; this design edits only `:9535-9537`). After the edit the
`claudeCloudTasks` import in `engine.ts` (`:16`) has no other use and goes. The
MCP registration lists (`bindings.ts`, `server.ts`) and `i18n/en.ts` and
`uk.ts` are edited by both, in separate entries, and the MCP files by several
open pull requests as well. The builder rereads ccda75f5's diff before editing and merges
after it when both are ready.

### 10. Tests (acceptance 4)

Provider fakes extend `src/lib/pipelines/claudeCloud.fixture.ts` with list
(including `has_more`), get, create (200, 401 `github_token_missing`, 400, 500,
a reply that never comes), update, `environment_providers` and the GitHub status,
and count every POST by path.

- `src/lib/projects/claudeCloudTasks.test.ts`: each row of §8 that does not
  need the engine; the claim with two concurrent slices on one store (one POST);
  the uncertain creation adopted on a later list, and released only after the
  window; the upsert keeping other accounts and predecessor entries; the 401
  mapping; authenticated connections have no permission-change remedy.
- `src/lib/pipelines/cloudClaudeClient.test.ts`: the admission test at
  `:591-600` changes, since admission now prepares: no binding with an empty
  list creates one task; a paused or connector-bearing task is fixed; a refused
  update keeps its reason.
- `src/lib/pipelines/engine.claudeCloud.test.ts`: the "no task for the account"
  and "connector on the task" cases at `:89-110` change to "prepared, then run in
  the cloud"; new: every account needs a human step → one local run whose
  `cloud.fallback.reason` names each account, reason and step URL; new: account
  B bound during account A's `submitting` → A's run completes without a park.
- `src/lib/mcp/claudeCloudTasks.integration.test.ts`, modelled on
  `src/lib/mcp/cloudEnvironments.integration.test.ts`: an SDK `Client` over the
  real server and tool service, the real binding and the real route served by
  `Bun.serve` on port 0; asserts read without provider calls, `prepare` refused
  for a worker and allowed for the root and the designated seat, an answer that
  returns before the slice ends, a replay and a retried POST that queue no
  second slice (count provider POSTs), and an injected route failure (503) that
  writes nothing.
- `src/app/api/projects/settings/route.test.ts`: the GET carries
  `claudeCloudReadiness`; the PUT cases at `:210-218` stay as they are.

Fixtures that enter the changed path: `cloudClaudeClient.test.ts` and
`engine.claudeCloud.test.ts` (both write `claudeCloudTasks` and reach
admission) and the Claude cases of `engine.cloud.test.ts` (`:201-216`, a fake
client, so preparation is not reached there). Each file runs with its own
`LLV_STATE_DIR`, HOME, XDG_CONFIG_HOME and TMPDIR; within a file, cases use
distinct project keys, so rows in `claude_cloud_tasks` never carry over.
Each lifecycle file (the engine and MCP files) runs in its own
`scripts/gate-slot.sh` command; typecheck, lint and the privacy gate run as the
project's hooks run them.

**The one real probe.** One `prepare` slice against the live API on the main
account, in an isolated state directory with no binding, with
`LLV_VIEWER_CONTROL_URL` on a closed port. Expected: the list (with the
product's headers) finds the existing Delegatus task, no POST is sent, the
isolated settings gain the binding, the row is ready. Recorded under
`$LLV_EVIDENCE_DIR`: methods, paths, statuses, response key names and the POST
count, with no id. If the third account's GitHub is connected before the probe
runs, the probe goes to that account instead and observes the creation path;
either way one account and one recorded run.

### 11. Slices

1. **Prepare and admit.** `claudeCloudTasks.ts` (store, reasons, slice),
   provider calls in `cloudClaudeClient.ts` (list, create, update,
   environments, GitHub status, the 401 helper), the shipped prompt moved to a
   constant `src/lib/pipelines/claudeCloudTaskPrompt.ts` with
   `docs/cloud/claude-task-prompt.md` keeping its explanation and pointing to the
   constant, `setClaudeCloudTaskFor`, the fence fix, admission. Tests of §10
   except MCP and the settings route.
2. **Readiness surface.** `claude_cloud_task`, its route, the settings GET field,
   the steps in `en.ts` and `uk.ts`. MCP SDK test and the settings route test.
3. **Live probe** on one account (§10), recorded.

After slice 1 alone, the next `claude-cloud` stage on this project binds the
existing tasks of the main and S0 accounts, runs in the cloud on one of them,
and names the third account's GitHub step in its reasons. After slice 2 the
seat reads every account and relays only missing identity-bound prerequisites.

## What of the Codex path this reuses

| Codex piece | Reused as |
| --- | --- |
| `prepareEnvironment` contract and result type (`cloudStage.ts:87`, `codexCloudEnvironments.ts:207-214`) | unchanged; the Claude slice returns the same type |
| Engine admission loop (`engine.ts:9352-9386`) | unchanged |
| Inline slice at admission (`cloudHostedClient.ts:390-395`) | same shape |
| Demand queue (`cloudEnvironmentDemand.ts:13-25`) | a Claude queue of the same shape for `prepare`, served by the Viewer without a walk |
| Binding store, alias keys, revision writes (`codexCloudEnvironments.ts:39-92`) | same `SqliteStateCollection` pattern, new collection |
| Creation claim and refusal-only release (`:311-327`, `:89-105`) | same rule, plus a list-proven release (§2.1) |
| Retry window and cooldown (`:241-245`, `:376-384`) | same numbers |
| Reason table (`cloudEnvironmentClient.ts:11-24`) | a parallel Claude table with steps |
| MCP tool, route and authority (`bindings.ts:4830-4838`, `:8865-8874`; `cloud-environments/route.ts`; `cloudEnvironmentAuthority.ts:10-20`) | copied for `claude_cloud_task`; the authority functions are called as they are |
| Settings GET field (`route.ts:113`) | `claudeCloudReadiness` beside it |
| Fallback record (`engine.ts:9625-9643`) and its board mark (`stageIdentity.ts:73-78`) | unchanged, shared with ccda75f5 |

Not reused: the background controller's walk over every project (scope, §1),
the default-branch lookup and per-ref keys (a Claude task serves any head of its
repository), and the draft and approval operations (Claude tasks have none).

## Deferred — not currently justified

- **A background walk over every scanned GitHub project**, as the Codex
  controller does. It would create tasks that cannot be deleted for projects
  that never asked for Claude Cloud. If wanted later, the controller gains an
  engine port (accounts, pool engine, account version, slice) and a demand queue
  per engine, since today's single queue would hand a Claude demand to the Codex
  controller under the same account id.
- **Updating the saved prompt of an existing task** through
  `job_config.ccr.events`: that update shape is unobserved. The name marker keeps
  existing tasks adoptable. The companion execution-policy lane must override
  any superseded routine instruction in its assignment, including the withdrawn
  capability check; preparation adds no eligibility check for it.
- **Renewing `run_once_at`** before it fires (the first existing task fires in
  2027-11). Readiness will show a task that ended.
- **A Settings UI row for Claude readiness.** Codex readiness has none; the seat
  relays readiness.
- **A seat action that binds an arbitrary task id.** The operator's PUT remains;
  preparation binds Delegatus's own tasks.
- **A readiness warning in `create_pipeline`.** Admission already says it per
  stage.
- **Translating engine fallback reasons on the board.** That belongs to the
  shared fallback display (ccda75f5); readiness steps are already translated.
- **Repository execution support.** This lane prepares scheduled tasks;
  execution capabilities remain with the execution client and its policy lane.
- **Choosing among several environments by setup script** (§4.4 step 3). Every
  account here has one Default environment.

## Validation against the requirement

| Criterion | Where it holds |
| --- | --- |
| 1: every Claude account of a GitHub project prepared automatically | §1 (every allowed account at each `claude-cloud` admission and each `prepare`), §2, §4 |
| 1: finds an existing task first; idempotent; never a duplicate | §2 step 4, §2.1, §8 rows 1–2 |
| 1: creates with the saved prompt, removes default connectors | §2 step 8 and the fix step |
| 1: records the id without replacing other entries | §5 |
| 2: readiness per account like `codex_cloud_environment` | §6 read, §7 |
| 2: human-only step named plainly in the operator's language, one action with its link | §7 steps |
| 3: says so at admission; no silent fallback; one mechanism with ccda75f5 | §4, §9 |
| 4: fakes, one recorded probe, isolated lifecycle files, MCP SDK on port 0, checks, privacy | §10 |
| a: agent path with its gate and consent | §6 |
| b: GitHub not connected names one step with its link | §2 step 6 and 8, §7 |
| c: a paused task is found and enabled | §2 fix, §8 |
| d: write access has no readiness penalty or remedy | Policy update, §7 |
| e: existing tasks adopted; their ids stay out of this text | §2 step 4, §11 |

## Unobserved, each failing safe

- The product's own headers on list, create and update. GET and run work with
  `ccr-triggers-2026-01-30` alone; the setup agent's list, update and create also
  sent `oauth-2025-04-20`. A refusal here answers 4xx, which proves no effect and
  shows as `create_refused` or `update_refused`. The live probe covers the list.
- Paging of `GET /v1/code/triggers`: only `has_more: false` has been seen.
  `true` stops creation (§2 step 4).
- Whether creation honours `clear_mcp_connections` every time: on 2026-11-11 it
  did, on 2026-11-01 (without the flag) two connectors appeared. The fix step
  reads the answer and clears again when needed.


## Questions for the operator

None blocks this design. Two choices are made here, and the operator can
reverse either:

1. Preparation runs for a project when it uses Claude Cloud or the seat asks
   (§1). Preparing every GitHub project at once would leave scheduled tasks that
   cannot be deleted on every account for projects that never asked for Claude
   Cloud.
2. A Claude stage whose accounts are all unavailable still runs locally, with
   the cause visible (§4, §9). Lane ccda75f5's draft parks Codex stages in the
   same situation; one condition in `fallback()` would make Claude park too.
