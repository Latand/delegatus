# Secure secret input: an agent asks, the operator types, Delegatus writes

Status: design only, written 2026-11-25 by the architect stage of the lane
«Безпечне введення пароля: дизайн». No product code changes here. Every code
claim was checked against `e9c4437d81` on `main`.

## Originating requirement

Operator request, 2026-11-25, spoken in the Delegatus project's orchestrator
conversation and paraphrased here: Delegatus should get a secure way to enter a
password or a similar secret. An orchestrator asks for it over MCP, the operator
types it, and the value is written wherever that orchestrator asked. Source: the
pinned task of this lane and the decision form the orchestrator attached to it.

The seat turned the request into four questions and gave a recommended answer
for each. The form was still open when this design was written, so the design
builds the recommended answers and keeps each alternative a contained switch
(§11).

| # | Ask | Where this design answers it |
|---|-----|------------------------------|
| R1 | An orchestrator asks for a secret over MCP | §4 `request_secret`, §5 who may ask |
| R2 | The operator types the secret in Delegatus, securely | §7 the card in the Decisions column, §8 how the value travels |
| R3 | The value is written where the caller named | §6 destinations and the write |
| R4 | The agent never sees the value; it learns saved, where, length (recommended answer 2) | §4.1 answer shape, §8 |
| R5 | Entry in Delegatus on desktop and phone, a masked field in the Decisions column, a Telegram notice without the value (recommended answer 3) | §7 |
| R6 | Orchestrators and the agents they launched may ask; each request shows who asks and where it writes (recommended answer 4) | §5, §7.3 |

**Should this be built: yes.** Without it, an agent that needs a credential
asks in chat and the operator pastes the value there. From that moment the value
sits in the agent's transcript, in the model provider's context, in any MCP
receipt or bridge report that quotes the turn, and possibly in Telegram. The
pattern redaction Delegatus applies when it shows text (§2.5) recognises
provider-shaped keys only, so a typed password passes through every one of those
places untouched. The requirement names this gap directly. The build stays small
because it reuses the Decisions column, the Keys field, the artifact route's
containment and the MCP-to-Viewer route pattern; the new parts are one small
request store, one destination writer and two tools.

## 1. Working defaults and the open form

| Question in the form | Recommended answer, built here | Alternatives (§11) |
|---|---|---|
| Where is the secret written? | A file at the path the agent names, inside allowed folders, mode 600; or a `NAME=value` line in a `.env` file | The system keyring (Secret Service) under a name; Delegatus's own key store (Settings → Keys) under a name |
| Does the agent see the value? | Never. It learns «saved, where, length»; the value never enters its transcript | It may read the value once |
| Where does the operator type it? | In Delegatus, desktop and phone: a request in the Decisions column with a masked field, and a Telegram notice without the value | Also directly in Telegram, as a reply to the bot |
| Who may ask? | Project orchestrators and the agents they launched; each request shows who asks and where it writes | Project orchestrators only |

## 2. What exists today, and what this design reuses

### 2.1 The decision-form surface

- **The column.** `DecisionList` (`src/components/decisions/DecisionColumn.tsx:45`)
  lists a project's open decisions newest first, keeps one form open and folds
  the rest to rows (`DecisionRow`, `src/components/decisions/DecisionCard.tsx:102`).
  Under the open form sits the withdraw control
  (`DecisionColumn.tsx:125`). The tabs and the count badge are `DecisionTabs`
  and `useOpenDecisionCount`; the seat header shows `DecisionStripLine`
  (`DecisionColumn.tsx:191`) while decisions wait out of sight.
- **Desktop and phone.** On the desktop the seat panel draws the column and
  registers it (`src/components/decisions/decisionSurface.ts:38`). Where no
  column stands, `openOperatorDecisions` opens one page-wide sheet:
  `DecisionSheet` (`src/components/decisions/DecisionSheet.tsx:24`) is a
  `MobileSheet` on the phone and a modal dialog on the desktop, both over the
  same `DecisionList`.
- **The read.** `useOperatorDecisions`
  (`src/components/decisions/useOperatorDecisions.ts:28`) polls
  `GET /api/projects/decisions` every 3 s (`DECISIONS_POLL_MS`, `:10`).
  `decisionsGET` (`src/lib/prototypeReview/http.ts:229`) answers it, gated by
  `rejectCrossOrigin` and `refuseAnonymous`.

**What the form must not carry for a secret.** The decision card was built for
answers that are meant to travel, and several of its paths would carry a value:

| Path | Where | Why a value must stay out |
|---|---|---|
| Drafts in `localStorage`, one key per round, kept up to 30 days | `src/components/prototypeReview/decisionDrafts.ts:8-21`, `:173` | The browser keeps every keystroke on disk |
| Dictation into the comment | `DecisionCard.tsx:193` | Speech goes to a transcription provider |
| The answer delivered as text to the seat | `prototypeDecisionText`, `src/lib/prototypeReview/decision.ts:61`; sent at `:175` | The text lands in the seat's transcript |
| Telegram text replies parsed as answers | `parsePrototypeAnswer`, `src/lib/prototypeReview/telegramAnswer.ts:35` | The value would cross Telegram |
| Rounds replicated to linked installs | `PrototypeReviewReplica`, `src/lib/prototypeReview/types.ts:182` | The value would cross to another machine |

A secret request therefore reuses the column, the row, the fold header, the
button styles, the withdraw slot, the sheet, the count and the deep link, and
gets its own card, store and routes (§7).

### 2.2 The keys store

- **Owner gate.** `keysOwnerGate` (`src/lib/keys/access.ts:41`) refuses a
  cross-origin request, any request carrying a spawn capability (valid or not),
  a Viewer service's own request and a request without a verified browser
  session (`operatorBrowserRequest`, `src/lib/agent/operatorAuthority.ts:74`),
  and on a team install everyone but the owner. The keys routes are classed
  `owner` in `src/lib/team/workspaceRoutes.ts:70-74`.
- **Bounded bodies, quiet errors.** `readBoundedJson` (`access.ts:52`) reads a
  body under a byte limit and never puts any of it in an error.
- **Audit.** One log line per action with the key id and never the value
  (`auditKeyAction`, `access.ts:75`). The keys design keeps key actions out of
  the lifecycle journal because that journal feeds agents' digests
  (`docs/design/keys-settings.md` §15).
- **The field.** `ValueField` (`src/components/keys/KeysSection.tsx:341`) is an
  uncontrolled `type="password"` input (`:368`) with `autoComplete="off"`, no
  spellcheck and password-manager opt-outs. It is read once on submit, emptied
  at once and never filled from a stored value.
- **The atomic private write.** `writePrivate`
  (`src/lib/voiceCompanion/storage.ts:142-152`) writes a `wx` temporary at mode
  600 beside the target, fsyncs, renames and fsyncs the parent. It also creates
  missing parent directories, which a write to an agent-named path must not do
  (§6.6).
- **The honest limit, already written down.** A process of the operator's own
  user can read the 600 files; the gates add no reach on the machine itself
  (`docs/design/keys-settings.md` §9). The same holds here (§8.4).

### 2.3 MCP tool registration

A tool is a name in `MCP_TOOL_NAMES` (`src/lib/mcp/server.ts:98`), a
classification in `MUTATING_MCP_TOOL_NAMES` (`:172`) or
`OPTIONAL_READ_KEY_TOOLS` (`:264`), optionally in
`INTERRUPTED_RECOVERABLE_TOOLS` (`:302`) when its Viewer route converges on a
re-dispatch, a description in `TOOL_DESCRIPTIONS` (`:4034`) and a schema in
`TOOL_INPUT_SCHEMAS` (`:4473`). One loop registers them all (`:5465`); every
call has a 30 s budget (`:5490-5493`). Every tool is offered to every agent;
authority is decided at the Viewer route. The binding posts to that route with
the caller's spawn capability, as `publish_prototype_review` and
`read_prototype_review` do (`src/lib/mcp/bindings.ts:9496-9513`). The route
names the caller from that capability (`callerConversationId`,
`operatorAuthority.ts:40`) and finds its project the way prototype publication
does (`prototypeWorld.caller`, `src/lib/prototypeReview/world.ts:30`).

### 2.4 The artifact route's containment

`/api/artifact` (`src/app/api/artifact/route.ts:20-40`, flow `:79-112`) admits
a path lexically, resolves links, admits the resolved path again, opens it with
`O_NOFOLLOW` and keeps the descriptor only when the opened file lies at the
admitted place (`openAdmitted`, `src/lib/artifact/localFile.ts:389`;
`descriptorPlace`, `:348`, through `/proc/self/fd` on Linux and
`O_NOFOLLOW_ANY` on macOS; Windows cannot tell and the stronger store refuses
there). The roots are the scanner's project folders and their checkouts
(`knownProjectFileRoots`, `src/lib/scanner/projectDirectories.ts:160`, used by
`projectRoots`, `localFile.ts:210`), manual projects and stage scratch. The home
directory itself is never a root (`lexicalAllowedRoots`, `:270`). Private areas
veto tool homes, config directories, the state directory and its account and
shared credential directories (`privateAreas`, `:156`). Fenced stores are
refused outright (`:96`). Hidden components are refused for reads
(`hiddenPathAllowed`, `:224`).

### 2.5 Privacy and redaction paths

- `redactMonitorText` (`src/lib/monitor/redact.ts`) runs the shared hardened
  redactor, then hides emails, home paths and absolute paths in anything the
  monitor emits. `conversation_messages` redacts on read.
- Both work on patterns. An operator's password has no pattern, and redaction
  on read leaves the stored transcript as it was. The design therefore keeps the
  value out of every store by construction and adds a canary test that looks for
  it in each one (§13).

### 2.6 Telegram

`sendOwnerReview` (`src/lib/telegram/bot/service.ts:1316-1356`) posts to the
paired owner's private chat under a durable claim; a message without a `review`
payload gets no polls. `postPrototypeReviewToTelegram`
(`src/lib/prototypeReview/telegramPost.ts:130`) records its outcome on the round
as codes only. Two facts shape what a notice may invite:

- The bot's own poller stores every incoming message in SQLite, and agents read
  that store with `telegram_bot_messages` (`docs/design/telegram-bot-account.md`,
  Decision 4).
- Where the hosted clone service owns the bot's webhook, a reply in the owner's
  private chat goes to that service's own answer path and never reaches
  Delegatus (`docs/design/telegram-prototype-review.md` §2.1, §2.5). A reply in a
  relay group reaches Delegatus as a relay request (`src/lib/externalRelay/runner.ts:772`
  matches prototype answers there).

Either way, a value typed into Telegram leaves the machine and can be stored
where agents or a third party can read it.

### 2.7 Who launched whom

| Field | Writer | Trust |
|---|---|---|
| `conversation.launcher.conversationId` | The MCP binding adds `launcherConversationId` from the server's attribution of the caller and drops any caller-supplied value (`spawnDispatchBody`, `src/lib/mcp/bindings.ts:1790-1797`; `mcpSpawnLauncher`, `:4894`); the spawn route accepts it only from the MCP service (`spawnLauncherFor`, `src/lib/agent/spawnCommand.ts:360-375`) | Server-attributed |
| `pipeline.srcConversationId` | `create_pipeline` requires `src` to be the authenticated caller's own transcript (`bindings.ts:2653-2673`); a seat's parallel self records the seat (`src/lib/pipelines/engine.ts:15833`) | Server-attributed for MCP-created lanes |
| A stage attempt's pipeline | `prototypeStageForConversation` (`world.ts:58`) finds the live attempt by conversation id | Server-recorded |
| `lineageEdges[id].parentConversationId` | Written from a spawn's `parentConversationId`, `parent` or `src` selector (`src/lib/agent/spawnParent.ts:53-80`), which the caller supplies | **Caller-claimed; unusable as authority** |
| The project's seat | `authorizedManagerSeats` (`src/lib/orchestrator/authority.ts:89`) through `prototypeWorld.orchestrator` (`world.ts:44`) | Server-recorded designation |

### 2.8 The listener in front of the Viewer

The runtime host's stable listener pipes TCP bytes to the serving release
(`serveViewerDeploymentProxy`, `src/runtime-host/deploymentProxy.ts`). It
parses, buffers and logs no request bodies, so this design changes nothing in
the runtime host.

## 3. The flow in one screen

1. An agent calls `request_secret` with a purpose and a destination. The MCP
   binding posts to `POST /api/secret-requests` with the caller's capability.
2. The Viewer checks the caller (§5), resolves and checks the destination (§6),
   stores a pending record that holds no value, posts a Telegram notice that
   holds no value (§7.5), and answers `pending` with the resolved destination.
3. The operator opens the request: from the Decisions column on the desktop,
   the decisions sheet on the phone, the seat's strip line or the notice's link.
4. The operator types the value into the masked field and presses Save. The
   page sends the bytes alone to `POST /api/secret-requests/<id>/value`, behind
   the Keys owner gate, with the destination revision the card showed.
5. The Viewer checks the destination again, writes the file atomically at mode
   600, records `entered` with the length, and zeroes the buffers it held.
6. Delegatus delivers one fixed-text message to the asking conversation, with
   the destination and the length (§4.4). The agent can also read the state
   with `read_secret_request`.

## 4. The MCP tool contract

### 4.1 `request_secret` (mutating)

Creates a request, or with `cancelRequestId` withdraws one of the caller's own.

| Argument | Type | Rule |
|---|---|---|
| `clientRequestId` | string | Required, the server-wide idempotency key |
| `purpose` | string, 1–300 characters | What the secret is for, shown to the operator as the agent's own words. Control and bidirectional formatting characters are removed before storage |
| `destination` | object | One of the two kinds below |
| `destination.kind: "file"` | `{ kind, path, replace?, trailingNewline? }` | `path` absolute (a leading `~/` expands to the home directory). `replace` defaults to false. `trailingNewline` defaults to true: the file holds the value and one newline, as the key store's writers do (`src/lib/keys/store.ts:29-35`) |
| `destination.kind: "env"` | `{ kind, path, key }` | `path` absolute; its file name must be `.env`, `.env.<suffix>` or `<name>.env`. `key` matches `^[A-Za-z_][A-Za-z0-9_]{0,63}$`, the Keys import's name rule (`src/lib/keys/shared.ts:94`) |
| `format` | `"line"` (default) or `"token"` | `line`: one line of UTF-8, 1–4096 bytes, no control characters. `token`: printable ASCII without spaces, the Keys rule (`shared.ts:55`) |
| `minLength` | integer 1–256 | Optional; counted in characters |
| `expiresInMinutes` | integer 5–10080 | Default 1440 (24 hours) |
| `taskId` | string | Optional; a task of the caller's project the card names. A pipeline stage's own task is used when omitted |
| `cancelRequestId` | string | Used alone with `clientRequestId`: withdraws a pending request the caller made |

No argument carries a value, a pattern or a regular expression. A pattern an
agent chooses could be a denial-of-service input, and accepting or refusing the
value against it would leak bits of the value to the agent.

**Answer on creation** (shape; values illustrative):

```json
{
  "requestId": "sr_<32 hex>",
  "reference": "#secret-<8 hex>",
  "state": "pending",
  "destination": { "kind": "env", "path": "<real path of the .env file>", "key": "SERVICE_TOKEN", "effect": "env-add", "git": "ignored" },
  "expiresAt": "2026-11-26T16:46:00.000Z",
  "telegramNotice": "sent",
  "next": "The operator was asked in Delegatus. Do not ask for the value in chat. You get one message when it is saved, declined or expired; read_secret_request reads the state."
}
```

`effect` is one of `file-create`, `file-replace`, `env-add`, `env-replace`;
`git` is `outside-repository` or `ignored` (§6.3).

**Answer once entered** (from `read_secret_request`, and the same facts in the
outcome message):

```json
{
  "requestId": "sr_<32 hex>",
  "state": "entered",
  "destination": { "kind": "file", "path": "<real path>", "effect": "file-create", "git": "outside-repository" },
  "length": 40,
  "enteredAt": "2026-11-25T17:02:11.000Z"
}
```

The answer carries no value, no masked form, no prefix or suffix and no hash.
A hash of a short password can be reversed offline by the agent that receives
it, so the length is the only fact about the value the agent learns.

**Refusals** (Viewer codes, lower snake case like the keys and workspace codes):

| Code | When |
|---|---|
| `secret_caller_not_allowed` | §5 does not admit the caller |
| `secret_destination_outside_roots` | §6.1 |
| `secret_destination_name` | A path component holds a control or bidirectional formatting character, or a component is `.git` |
| `secret_destination_private` | The path lies in a private area or a fenced store (§6.2) |
| `secret_destination_link` | The final component is a symbolic link, or resolving the parent leaves the roots |
| `secret_destination_exists` | The file exists and `replace` is false |
| `secret_destination_not_replaceable` | The existing file is executable, larger than 64 KiB, hard-linked, not a regular file or owned by another user |
| `secret_destination_tracked` | Git tracks the file |
| `secret_destination_not_ignored` | The path lies in a git work tree and the repository's ignore rules do not ignore it |
| `secret_parent_missing` | The parent directory does not exist (§6.4) |
| `secret_destination_unavailable` | The Viewer cannot see the path (a Docker install, §6.8) |
| `secret_env_file_name` | An `env` destination whose file name is not a `.env` name |
| `secret_env_key_invalid` | The key fails the name rule |
| `secret_env_key_duplicated` | The `.env` file defines the key more than once |
| `secret_env_unparsed` | The `.env` file cannot be scanned (an unterminated quote, over 1 MiB) |
| `secret_too_many_open` | The caller has 3 pending requests, or the project has 10 |
| `secret_platform_unsupported` | The platform cannot confirm a descriptor's place (Windows, §2.4) |
| `staging` | A staging release, which shares production's files (keys precedent, `src/app/api/keys/[id]/route.ts`) |
| `idempotency_conflict` | The same `clientRequestId` arrived with different arguments |

**Idempotency.** The Viewer derives the request id from the caller and the key:
`sr_` and the first 32 hex digits of the SHA-256 of
`secret-request-v1:<conversationId>:<clientRequestId>`, and stores a digest of
the arguments. A repeat with the same key and digest answers the stored request
with its current state and changes nothing; the Telegram notice keeps its own
claim key (`secret:<requestId>`) and is never sent twice. A repeat with
different arguments is refused. The tool joins `MUTATING_MCP_TOOL_NAMES` (a
durable receipt) and `INTERRUPTED_RECOVERABLE_TOOLS`: a call whose answer was
lost is re-dispatched once and converges on the same record, which is the
`publish_prototype_review` reasoning at `server.ts:302-320`. The cases where an
effect lands and its answer is lost are walked through in §13, test 7.

### 4.2 `read_secret_request` (read)

`{ requestId }` reads one request; `{ state?, limit? }` lists the caller's own
requests, newest first, at most 20. The project's seat may read every request of
its project; another caller reads only its own. The answer is the shape above.
It joins `OPTIONAL_READ_KEY_TOOLS`; a read changes nothing, except that a
pending request past its expiry is answered and recorded as `expired`.

### 4.3 Registration

- `src/lib/mcp/server.ts`: both names in `MCP_TOOL_NAMES`, the classifications
  above, descriptions, schemas. The schema of `destination` is a discriminated
  union on `kind`.
- `src/lib/mcp/bindings.ts`: two bindings that post to
  `POST /api/secret-requests` (create and cancel) and
  `POST /api/secret-requests/read` with the caller's capability, the way
  `publish_prototype_review` does. The binding forwards the arguments and adds
  nothing the caller could not supply.
- `src/lib/team/workspaceRoutes.ts`: the two agent routes are `project`, like
  `/api/prototype-reviews`; the operator routes of §7 are `owner`, like
  `/api/keys`. None is on the peer surface (`/api/peer`, `src/proxy.ts:13`).

### 4.4 The outcome message

When a request leaves `pending`, Delegatus sends one message through the same
conversation-host send that decision delivery uses (`decision.ts:175`), with
the deterministic `clientMessageId` `secret-request:<requestId>:<state>`, so a
retry can never deliver twice. The text is assembled from server fields only:

- entered: «Secret request #secret-ab12cd34 ("<purpose, first 80 characters>"):
  saved to `<real path>` (new file, mode 600), 40 characters. You were not shown
  the value; do not print, copy or commit the file.»
- declined: «… declined by the operator; nothing was written.»
- withdrawn by the agent: no message.
- expired: «… expired at 16:46 without an answer; nothing was written.»

The message goes to the asking conversation. When that conversation can no
longer take messages (its stage attempt settled, or it ended), it goes to the
project's seat. Three attempts at most; an uncertain send stays recorded as
uncertain and the state remains readable with `read_secret_request`.

## 5. Who may ask, and how the request names the caller

**The rule** (recommended answer 4). The route names the caller from its
capability. The caller's project is the canonical project of its conversation
(`prototypeWorld.caller`). The caller may ask when one of these holds:

1. It is the project's authorized seat (`prototypeWorld.orchestrator(project)`).
2. It descends from that seat through server-attributed links only (§2.7), at
   most four steps: a `launcher` set by the MCP server, or a live stage attempt
   of a pipeline whose `srcConversationId` is the seat or a conversation already
   admitted by this rule. Every conversation on the chain belongs to the same
   project.

Refused: a conversation the operator started by hand, the Telegram relay's
owner agent, a linked install, a conversation whose only link to the seat is a
lineage edge (caller-claimed), and a child of a seat that has since been
rotated out (its launcher is no longer the authorized seat). The refusal text
tells the agent to ask the project's orchestrator, which can ask on its behalf.
Whether a seat's parallel self (`docs/design/ghost-seat.md`) qualifies depends
on which of these links its launch records; this design did not trace it, so
slice 1 reads that path and adds a case either way (§13, test 4). The operator
never calls this tool; the operator answers.

The form's other answer, «orchestrators only», deletes step 2 (§11.4).

**How the request names the caller.** Every name on the card comes from the
server's records, captured when the request is made:

- the requester's role: «оркестратор проєкту», the spawn role (`builder`,
  `reviewer`, …) or «етап <stage id> лінії <pipeline id>»;
- its board title, engine and model;
- the chain to the seat when the requester is not the seat: «запущений
  оркестратором "<seat title>"»;
- the task, when one is linked;
- when the request was made, and when it expires.

The agent's own `purpose` is shown after these, in a block labelled as the
agent's words (§7.3). Nothing an agent supplies is drawn as an identity.

## 6. Destinations

### 6.1 Allowed roots

A destination must lie under one of:

1. **The caller's own project folders**: every root `knownProjectFileRoots`
   records whose canonical project equals the caller's (the repository root,
   its linked checkouts and lane worktrees), plus the project's manual root.
   This is the artifact route's root list (§2.4) narrowed to one project, as the
   route's own workspace check narrows it (`route.ts:104`). Stage scratch is
   excluded: it is removed when the stage settles.
2. **Folders the operator added**, listed in `LLV_SECRET_ROOTS` (absolute
   paths separated by `:`, the convention of `LLV_EVIDENCE_ROOTS`,
   `localFile.ts:45-50`). Each is resolved once; the home directory itself, a
   folder that contains the home directory, and any private area are dropped.
   Unset, the list is empty.

A secret written into a lane worktree goes away with that worktree.

### 6.2 Path refusals

The checks run in this order, at creation and again immediately before the
write:

1. The path is absolute after `~/` expansion, and no component holds a control
   character or a bidirectional formatting character (U+202A–U+202E,
   U+2066–U+2069). Such characters let a path read differently on the card from
   what the file system receives.
2. **Lexical admission.** The resolved lexical path lies under an allowed root
   (`underRoot`, `localFile.ts:39`); no component is `.git`; the path is outside
   every private area and fenced store (`privateAreas` and `fencedStores`,
   reused; today `privateAreas` is module-private, and slice 1 exports a
   predicate over it). Hidden names are allowed, because `.env` is one; the
   artifact route's hidden-name rule is a read rule and stays there.
3. **Real admission.** The parent directory is resolved with `realpath` and
   must still pass step 2 against the resolved roots (`realAllowedRootsSync`,
   `:284`). A link in the parent chain that leads elsewhere inside the roots is
   allowed and shown resolved on the card; one that leads out is refused.
4. **The final component.** `lstat`: absent, or a regular file owned by the
   Viewer's user. A symbolic link at the final name is refused, and the card
   tells the operator the link exists (a `.env` link into a shared folder is a
   real setup; replacing it with a regular file would break it silently).
5. **Replace rules.** An existing file needs `replace: true` for the `file`
   kind; an `env` destination always edits in place. A file that is
   executable, larger than 64 KiB or has more than one hard link is never
   replaced.
6. **Git** (§6.3).

### 6.3 The git rule

The pinned specification says never into a git-tracked file unless it is
gitignored. A tracked file stays tracked when `.gitignore` lists it, and
`git commit -a` commits it, so the rule here is the outcome that sentence
serves: **inside a git work tree, the destination must be untracked and
ignored by the repository's own rules.** Outside any work tree the rule does
not apply.

Two commands answer it. `git rev-parse --is-inside-work-tree`, run in the
parent directory, decides whether the rule applies. `git check-ignore -q --
<path>` without `--no-index` then answers both halves at once, because it
reports a tracked file as not ignored. Both run with the environment of
`gitEnvironment()`
(`src/lib/pipelines/initializeRepository.ts:162-166`: every `GIT_*` variable
removed, no system or global configuration), plus `-c core.fsmonitor=false`
and a 15 s timeout, so a hostile repository configuration cannot run a
program. Without the global configuration a user-wide excludes file does not
count. That is deliberate: another clone of the same repository would not have
it. A destination that is not ignored is refused with
`secret_destination_not_ignored`; the agent can add an ignore rule, a change
that is reviewed and committed in the open, and ask again.

### 6.4 The `file` kind

The parent directory must exist. Delegatus creates no directories at an
agent-named path; the agent can create the folder itself. The file holds the
value's bytes and, by default, one `\n`.

### 6.5 The `env` kind

The `.env` file is read as bytes (at most 1 MiB) and scanned line by line with
a small tokenizer that tracks quotes across lines, so a line inside a
multi-line quoted value is never taken for a definition. A definition is a
line whose first token, after an optional `export `, is `KEY=`.

- **No definition of the key:** one line is appended. If the file does not end
  with a newline, one is added first. The line ending follows the file: CRLF
  when the file uses CRLF.
- **One definition:** that line is replaced in place, keeping its `export `
  prefix. Every other byte of the file stays as it was: comments, order, blank
  lines, other keys.
- **More than one definition:** refused with `secret_env_key_duplicated`.
  Parsers disagree on which definition wins, and editing one of them could
  leave the other one in force.
- **No file:** created with the one line.

**How the value is written on the line.** A value made only of
`A-Z a-z 0-9 _ . / : @ % + = , - ~` is written bare. Any other value is written
inside single quotes, where Node's dotenv, Docker Compose and a shell expand
nothing. Two parsers still read some characters there: Python's dotenv turns
`\\` and `\'` into one character, and Bun's loader (1.4.0, probed for this
design with `bun --env-file`) replaced `$HOME` inside single quotes with the
home directory while it kept backslashes, `#`, double quotes and backticks as
written. A value that contains a single quote, a backslash, a dollar sign or a
line break therefore cannot be one line that every parser reads the same way:
the entry is refused with
`secret_env_value_unquotable`, and the card tells the operator to ask for a
`file` destination. The test round-trips every accepted value through Bun's
own `.env` loader (§13, test 3).

After the write the file's mode is 600, whatever it was before; the card says
so in advance («права файлу стануть 600»), because a service that read the
file under another user would stop reading it.

### 6.6 The write

The writer is new code that follows `writePrivate`'s sequence without its
directory creation, and adds the artifact route's descriptor check. It holds
one lock per destination (`withFileTransaction`,
`src/lib/state/fileTransaction.ts`), so two requests for the same file write
one after the other.

1. Under the request's own lock: the request is `pending` and unexpired, the
   destination revision the page sent equals the one computed now (§7.1), and
   every check of §6.2 passes again. The record moves to `writing` with a
   write id and is persisted.
2. For `env`: the existing file is opened with `openAdmitted` (`O_NOFOLLOW`
   and a confirmed descriptor place), read through that descriptor, and its
   identity (device, inode, size, change time) is kept. The new content is
   composed as buffers (§8.3).
3. A temporary `<name>.<write id>.tmp` is created beside the destination with
   `wx` and mode 600; its descriptor place must be the expected real path
   (`descriptorPlace` true; `null` refuses with `secret_platform_unsupported`).
   The bytes are written and fsynced; the temporary's inode is persisted on the
   record.
4. For `env`: the existing file's identity is compared once more; a change since
   step 2 refuses with `secret_destination_changed`, removes the temporary and
   leaves the request pending.
5. `rename` onto the destination, then fsync of the parent directory. A rename
   replaces a link planted at the final name and never follows it.
6. `lstat` of the destination must show the temporary's inode and mode 600. The
   record moves to `entered` with the length, the effect and the inode, and the
   lock is released.

Any refusal or error removes the temporary, zeroes the buffers and puts the
request back to `pending` with the refusal code, which the card shows.

### 6.7 Recovery after a crash

A Viewer that stops between steps 1 and 6 leaves a record in `writing`. At
startup and on every read of that record:

- the destination's inode equals the recorded temporary inode → `entered`
  (the rename happened);
- otherwise a leftover `<name>.<write id>.tmp` is removed, because it holds the
  value, and the request returns to `pending` with
  `secret_entry_interrupted`; the card asks the operator to enter it again.

### 6.8 Docker installs

On a Docker install the Viewer writes from inside the container. The compose
file mounts the home directory at the same path (`docker-compose.yml:33`), so
project folders under it resolve the same and files get the configured user id.
A project outside the home directory is invisible there and is refused with
`secret_destination_unavailable` at creation.

## 7. The request's life and where it appears

### 7.1 States

| State | Entered by | Leaves to |
|---|---|---|
| `pending` | `request_secret` | `writing`, `cancelled`, `expired` |
| `writing` | The operator's Save (§6.6 step 1) | `entered`; back to `pending` on a refusal or after a crash |
| `entered` | The rename and its check | Terminal |
| `cancelled` | The operator's Decline, or the agent's `cancelRequestId` | Terminal |
| `expired` | A read, a write attempt or the hourly sweep after `expiresAt` | Terminal |

The record keeps a **destination revision**: the SHA-256 of the real path, the
kind, the key, the effect and the git status. The card sends the revision it
showed with the value; when the Viewer's own computation differs at write time
(a file appeared, a link appeared, the key gained a second definition), the
write is refused with `secret_destination_changed` and the card redraws with
the new facts. The keys import guards a replacement the same way, with a
fingerprint of what the operator confirmed (`keyRevision`,
`src/lib/keys/store.ts:107`).

**Limits.** 3 pending requests per asking conversation and 10 per project.
Expiry from 5 minutes to 7 days, 24 hours by default. A sweep once an hour
reads only pending requests, records the expired ones and sends their outcome
messages.

### 7.2 Storage of the record

One `SqliteStateCollection` named `secret-requests` in `state.sqlite`, the
mechanism seat rounds use (`src/lib/prototypeReview/seatRounds.ts`). A record
holds the request, the requester as captured, the destination, the revision,
the transitions and the audit fields of §9. It never holds the value or
anything derived from it except its length. Terminal records are kept 90 days
or the newest 500, whichever is fewer. The collection never travels on the task
wire, so linked installs never see it.

### 7.3 The card: desktop column and phone sheet

The column's read grows by one field. `decisionsGET` adds
`secretRequests: SecretRequestView[]` to its answer when the request passes
`keysOwnerRequest` (`access.ts:34`), and omits the field otherwise; members of
a team install and agents never receive it. `useOperatorDecisions` keeps its
one 3-second poll; `DecisionList` merges the two lists by creation time, newest
first, keeps its one-open-form rule, and draws a secret request through
`SecretRequestCard` when open and through the existing row when folded (with
the `KeyRound` icon where a decision shows a question mark). The phone gets the
same card inside `DecisionSheet` with the list's `touch` sizing. No new panel,
tab or menu is added.

What the open card shows, top to bottom (Ukrainian; the English catalog
mirrors it):

1. The fold header with the title «Запит секрету · .env → SERVICE_TOKEN» or
   «Запит секрету · token.txt», built from the destination.
2. **Хто просить:** the server-derived identity of §5 and the time.
3. **Куди:** the real path in monospace, wrapping anywhere; under it the effect
   in words («Новий файл · права 600», «Замінить файл: 1,2 КБ, змінено 3 дні
   тому · права 600», «Додасть SERVICE_TOKEN у .env · права файлу стануть
   600», «Замінить значення SERVICE_TOKEN у .env · права файлу стануть 600»)
   and the git status («Поза репозиторієм» or «Ігнорується git»). When an
   earlier request already set this destination, one more line says when:
   «Уже задано 25.11 о 16:20 (#secret-1a2b3c4d)».
4. **Пояснення агента:** the purpose as plain text in a quoted block, at most
   300 characters, with no links or formatting.
5. A fixed line: «Значення не потрапить у розмову, журнали чи Telegram.
   Агенти цього проєкту зможуть прочитати цей файл.»
6. The field: the Keys `ValueField`, moved to a shared module so both surfaces
   use one component. It is uncontrolled, `type="password"`, with
   `autoComplete="off"`, `autoCorrect="off"`, `autoCapitalize="none"`, no
   spellcheck and the password-manager opt-outs, and an eye toggle that only
   switches the input's type in the page. No draft, no dictation button, no
   value in React state. A hint under it states the format: «Один рядок» or
   «Без пробілів, щонайменше 20 символів».
7. **Зберегти** (the primary button) and, in the withdraw slot under the card,
   **Відхилити**. Save is enabled once the field satisfies the format and the
   minimum length, checked in the page; the server checks again.
8. «Чекає до 18:40».

On Save the page sends the field's bytes, empties the field at once and shows
the saving state on the button. On success the card leaves the column and a
short status line says «Збережено в .env». A refusal keeps the card, shows the
reason under the button, redraws the destination facts when they changed, and
leaves the field empty. A narrow column (below 460 px, or the phone) drops the
time from the identity line; the path, the effect and the warning stay.

The page checks the format, the minimum length and, for an `env` destination,
the characters of §6.5 before it enables Save; the server repeats every check.
Entry refusals, each shown under the button in the operator's language:

| Code | Meaning |
|---|---|
| `operator_only`, `owner_required` | The Keys owner gate refused the request (§2.2) |
| `staging` | A staging release shares production's files |
| `secret_not_pending` | Already entered, declined or withdrawn; nothing written |
| `secret_expired` | Past its expiry; nothing written |
| `secret_destination_changed` | The destination's facts differ from what the card showed, or the `.env` file changed during the write; the card redraws |
| `secret_value_format` | The bytes break the request's format or minimum length |
| `secret_value_too_long` | Over 4096 bytes, or a body over 16 KiB |
| `secret_env_value_unquotable` | §6.5; ask for a `file` destination |
| `secret_entry_interrupted` | A previous attempt stopped mid-write (§6.7); enter it again |
| Any §4.1 destination code | A check of §6.2 or §6.3 fails now |

When the page is not a secure context and its host is not a loopback address,
one line above the field says the connection is unencrypted. Save stays
enabled: a tailnet address served over plain HTTP is already encrypted by the
tunnel.

### 7.4 Count, strip line, needs-you and the link

- The page's main poll (`src/app/api/files/response.ts:1073`) adds
  `secretRequestNotices` for owner sessions; the team projection
  (`src/lib/team/workspaceProjection.ts:33`) drops the field for members. The
  Decisions badge, the seat's strip line and the board's needs-you
  (`src/lib/attention/needsYouProjection.ts:60`) count them with the prototype
  notices. The collection is read through the collection read cache
  (`src/lib/state/collectionReadCache.ts`), so the poll does no extra work while
  nothing changed.
- The link `?project=<key>&secretRequest=<id>` opens the request through
  `openOperatorDecisions({ project, reviewId: id })`; the prototype review host
  that already handles `prototypeReview` reads the new parameter.

### 7.5 The Telegram notice

On creation, one message to the paired owner chat through `sendOwnerReview`
with no `review` payload and the claim key `secret:<requestId>`. Its outcome is
recorded on the request as a code, the way `telegramPost` records a round's
(`telegramPost.ts:130`). The text is in the operator's interface language:

> 🔑 Запит секрету · Delegatus
> Просить: етап design лінії 846548fd (Claude)
> Куди: .env → SERVICE_TOKEN (у теці проєкту)
> Чекає до 18:40. Ввести можна лише в Delegatus: <link>
> Не надсилайте значення в цей чат. #secret-ab12cd34

The destination is shown relative to its root, so the notice carries no home
path. The agent's purpose stays out of the notice: it is the one field an
agent controls, and a phone preview is where a convincing sentence works best.
Telegram not set up is recorded as `failed` with the destination reason, and
the request waits in the column as before.

A reply to the notice is withheld where Delegatus can recognise it. When
Delegatus's own bot poller receives the chat's updates, a message whose
`reply_to_message` is a recorded notice is stored with its text removed and
`kind: "withheld"`, so `telegram_bot_messages` never returns it; the bot
deletes it (the Bot API lets a bot delete incoming messages in a private chat
within 48 hours) and answers with one fixed line pointing to Delegatus.

Elsewhere Delegatus cannot help. A reply that the hosted clone service answers
never reaches Delegatus. A reply that comes back as a relay request arrives
without its parent, because the service does not keep messages Delegatus sent
through the bot token (`docs/design/telegram-prototype-review.md` §2.3), so
the runner has nothing to match; and the value has reached the service by
then anyway. A value pasted as a fresh message carries no reference at all.
The notice's last line exists for those cases (§8.4).

### 7.6 Team installs and linked installs

The owner of a team install enters and declines; members see no secret requests,
no notices and no counts. Requests are made only by conversations of this
install and stay on it.

## 8. How the value travels and where it is kept

### 8.1 The path of the value

1. The operator types into the password input. The page holds the value only as
   the input's own value.
2. On Save the page encodes it once (`TextEncoder`), sends
   `POST /api/secret-requests/<id>/value` with
   `Content-Type: application/octet-stream`, the body being the bytes alone,
   and the revision in the `x-llv-secret-revision` header. It then zeroes the
   encoded array and empties the input.
3. The route runs `keysOwnerGate`, refuses a staging release, reads the body
   through the stream reader with a 16 KiB bound and zeroes each chunk after
   copying it. It never decodes the bytes to a JavaScript string and never
   parses them as JSON.
4. The format check (§4.1) and the character count run on the bytes
   (`isUtf8` for `line`, a byte range for `token`, counting the bytes that start
   a character).
5. The writer (§6.6) writes the bytes, or for `env` a buffer composed from
   slices of the old file and the new line.
6. In a `finally`, every buffer that held the value is filled with zeros. The
   answer is the column's next read, with no value in it.

### 8.2 Where the value never goes

| Place | Why it cannot get there | Test (§13) |
|---|---|---|
| The asking agent's transcript and the model's context | The MCP binding and the Viewer's agent routes never receive it; answers and the outcome message are assembled from record fields, which hold no value | 6, 7 |
| MCP receipts and message receipts | Same; the operator's entry is an HTTP call outside MCP | 6, 7 |
| The request record and `state.sqlite` backups | The record has no value field; the writer receives the buffer as a function argument | 6 |
| Viewer logs and error answers | The route logs one line with the request id and a code; errors answer codes; no exception message is built from the body | 6 |
| Bridge reports and Telegram | The notice and the outcome have no value to quote; the seat never had it | 6, 8 |
| Browser storage | No draft, no `localStorage`, no URL parameter, no React state; the field is uncontrolled | 9 |
| Dictation and transcription providers | The card has no microphone | 9 |
| Linked installs | The collection is off the task wire; the routes are off the peer surface | 5 |
| The runtime host | A raw TCP pipe (§2.8) | none needed |
| Crash dumps | The value is held for milliseconds and zeroed in `finally`; see §8.4 | 6 |

### 8.3 Memory

JavaScript strings cannot be wiped, so the server never makes one from the
value; buffers can, and are. What stays outside reach: the input's string in the
browser until the page's garbage collector reclaims it, and the Viewer's socket
read buffers below the request stream until they are reused. The window during
which the Viewer holds the value is one request.

### 8.4 Honest limits

- **Agents of the operator's user can read the file.** The file is mode 600 for
  the user every agent runs as; an agent with a shell can `cat` it, and the
  value then enters that agent's transcript. Delegatus keeps the value out of
  everything it hands an agent, tells the agent not to read the file, and says
  on the card that agents can. Confidentiality from agents themselves needs a
  separate operating-system identity for them (§16).
- **The same user can race the write.** The descriptor and inode checks of
  §6.6 hold against everything that does not already run code as this user; a
  process that does could read or redirect the file anyway.
- **A crash during the write window** could put the buffer into a core dump
  where the system collects them. The window is milliseconds.
- **Telegram.** A value typed into Telegram by mistake can stay with Telegram
  and with the hosted clone service; Delegatus can withhold and delete only
  what reaches its own bot (§7.5).

## 9. Audit record

The request record is the audit. It holds:

- created: time, requester identity as captured (§5), project, task, purpose,
  destination and revision, expiry;
- each transition: time, state, and the actor (`operator`, `owner`, `requester`,
  `expiry`, `recovery`);
- entered: length, effect, the destination's inode, and whether a previous file
  or line was replaced;
- refusals on entry attempts: code and time, the last 10;
- the Telegram notice outcome and the outcome message's delivery state.

It holds no value, no hash and no masked form. One log line per transition,
`[secret-request] sr_ab12cd34 entered env-add`, names the request, the state and
the effect, with no path and no purpose. As with keys, nothing goes to the
lifecycle journal, which feeds agents' digests. The owner reads the record on
the card while it waits; agents read it with `read_secret_request`. An owner's
history page is deferred (§16).

## 10. Threats and mitigations

| Threat | Mitigation | Residual |
|---|---|---|
| A compromised or prompt-injected agent asks for an unrelated secret («your bank password, to store in .env») | Identity drawn from server records first, the agent's words second and labelled; the destination must be inside the requester's project or an operator-added folder; the card says agents of the project can read the file; the notice carries no agent text; 3 pending per conversation, 10 per project; expiry; Decline | The operator decides on what the card shows |
| Repeated asks to wear the operator down, or to collect a rotated value | Rate limits; the card shows when the same destination was last set and by which request | — |
| Misleading text on the card | Purpose stripped of control and bidirectional characters, plain text, 300 characters; paths with such characters are refused | Look-alike letters in a file name stay visible as written |
| Path traversal | Lexical admission, then `realpath` of the parent and admission again, as `/api/artifact` | — |
| A link at the final name or in the parent chain | Final links refused; parent links admitted only when their target is inside the roots; the temporary's descriptor place is checked; rename replaces a planted link without following it | Same-user races (§8.4) |
| Overwriting an important file | `replace` is explicit and shown; executables, files over 64 KiB, hard-linked and foreign-owned files are never replaced; tracked files never; `.git` components never; private areas and fenced stores never | A small ignored file the operator confirms |
| A secret committed to git | Inside a work tree the destination must be untracked and ignored by the repository's own rules | A later `git add -f` by someone |
| A hostile repository configuration runs code during the git check | `gitEnvironment()` without system or global configuration, `core.fsmonitor=false`, timeout | — |
| Entry through a forged request (another site, DNS rebinding, an agent with a capability) | `keysOwnerGate`: same origin and pinned Host, no spawn capability, no Viewer service claim, a verified browser session, the owner on a team install | A same-user process that steals the browser session |
| Replaying the operator's entry | One entry per request: the state moves under a lock, a second POST answers `secret_not_pending` and writes nothing | — |
| Entering into a destination that changed after the card was drawn | The revision the card showed must match at write time | — |
| Replaying an MCP call | Request id derived from the caller and key, argument digest, one notice claim | — |
| A lost answer after the effect landed | Create: the re-dispatch finds the record. Entry: the next read shows `entered`; a new entry is refused. Crash mid-write: §6.7 | — |
| A value typed into Telegram | Notice warns; replies withheld from agents and deleted where Delegatus's bot receives them | §8.4 |
| The value read from the Viewer's memory | Held for one request, never a string, zeroed. Under Yama `ptrace_scope` 1 (the Ubuntu default, and the setting on the design machine) a process can attach only to its own descendants, so agents cannot read the Viewer's memory | Core dumps, swap, and machines with `ptrace_scope` 0 |

## 11. The alternatives in the form, and what each changes

Each alternative is a contained change: destinations sit behind one
`SecretDestination` union with a resolver and a writer per kind; the caller
rule is one predicate; the Telegram notice is one module.

### 11.1 The system keyring (Secret Service) under a name

- **Contract:** a third kind `{ kind: "keyring", name }`; `path`, `replace`,
  the git rule and the `.env` rules do not apply to it. The answer names the
  keyring item.
- **Writer:** `secret-tool store --label "Delegatus · <project> · <name>"
  service delegatus project <key> name <name>`, the value on standard input,
  never in arguments. On the design machine the tool and a session bus were
  present in an agent's shell; the Viewer runs as a service, so slice 1 would
  have to probe that it reaches an unlocked collection from there. A Docker
  install has no session bus and cannot offer this kind. macOS's `security`
  command takes a password as an argument, which other processes can see, so
  macOS would need the Keychain API through FFI.
- **Reading it:** whatever uses the secret calls `secret-tool lookup`, which
  any process of the same user in that session can also call. Against agents
  this is as strong as a 600 file; it does keep the value out of every folder.
- **Card:** «Куди: системне сховище ключів · delegatus / <name>».

### 11.2 Delegatus's own key store under a name

- **Contract:** `{ kind: "store", name }`. Delegatus picks the file:
  `secrets/<project>/<name>` under its config directory, written with the key
  store's private write, so containment and git rules disappear.
- **Keys page:** a «Секрети проєктів» group in Settings → Keys with the existing
  reveal, copy, replace and remove controls, owner only. Open pull request
  #4416 rewrites `KeysSection.tsx`; this alternative would follow it.
- **Reading it:** an agent would need either the path (the same exposure as
  §8.4) or a new launch-time injection of named secrets into an agent's
  environment, which hands the value to the agent and contradicts the
  recommended answer 2. The config directory is a private area for every other
  Delegatus reader.
- **Gain:** one place to see, rotate and remove project secrets.

### 11.3 The agent may read the value once

- A second read tool returns the value one time. The value then sits in the
  agent's transcript and the model provider's context for good, which is the
  outcome the requirement set out to avoid.
- The record would have to keep the value, encrypted, until that read; the tool
  would have to be receipt-free like the relay tools (`RECEIPT_FREE_READ_TOOLS`,
  `server.ts:261`); the canary tests of §13 would have to exempt that one path.
- Not recommended.

### 11.4 Orchestrators only

- §5 step 2 is deleted. A launched agent or a stage that needs a secret tells
  its seat, which asks.
- Every test case of an admitted launched agent becomes a refusal case.

### 11.5 Also in Telegram

- A reply to the notice would carry the value. The bot's poller (§7.5) would
  route such a reply to the writer, store nothing, and delete the message.
- This works only when Delegatus's own bot receives the chat's updates. Where
  the hosted clone service owns the webhook, a private-chat reply never reaches
  Delegatus, and a relay request arrives without the parent it replied to
  (§2.6, §7.5), so the reply cannot be tied to a request. A reference typed by
  hand would be needed, and the relay's 30-day answer record would need an
  exclusion.
- In every case the value crosses Telegram, and possibly the hosted service,
  and stays in the chat's history until the deletion lands.
- Not recommended.

## 12. Other mechanisms considered and dropped

| Mechanism | What the check showed |
|---|---|
| A «secret» question kind inside the existing decision forms (`publish_prototype_review`) | The round's answer is delivered as text to the seat, kept as a browser draft, offered to dictation, parsed from Telegram replies and replicated to linked installs (§2.1). Removing all five for one question kind forks the round machinery; a separate card and store are smaller |
| `request_secret` waits until the operator answers | A tool call has a 30 s budget (`server.ts:5490-5493`); people answer in minutes or hours |
| The answer carries a hash so the agent can check the value | An agent can brute-force a short password from its hash offline |
| The value in a JSON body | `JSON.parse` makes a string that cannot be wiped; a byte body read into buffers can be |
| A one-time entry link without a session, for the phone | The phone already reaches the Viewer with the session the owner gate checks |
| A Settings editor for extra folders | No existing control fits; the environment variable covers the need until it is asked for (§16) |

## 13. Tests

Every test runs by path with a private HOME, XDG_CONFIG_HOME, TMPDIR and
`LLV_STATE_DIR`, and `LLV_VIEWER_CONTROL_URL` on a closed port. Tests check
behaviour; none reads prompts or tool descriptions for phrases.

1. **Destination** (`src/lib/secretRequests/destination.test.ts`): relative
   path; `..` traversal; a parent link that leaves the roots and one that stays
   inside; a link at the final name; a hard-linked file; a `.git` component and
   a `.git` file; the state directory, a tool home and the config directory;
   a fenced store; the home directory as a root; another project's folder; a
   missing parent; an existing file with and without `replace`; executable,
   oversized and foreign-owned files; control and bidirectional characters;
   `.env` name rules and the key rule; an operator-added root and one that
   contains the home directory.
2. **Git** (same file): tracked and ignored by a pattern → refused; untracked
   and not ignored → refused; untracked and ignored → admitted; outside a work
   tree → admitted; a repository whose `core.fsmonitor` names a script that
   writes a marker file → the marker never appears.
3. **`.env`** (`envFile.test.ts`): append to a file with and without a final
   newline; replace one definition keeping `export `; CRLF kept; a duplicate
   refused; a `KEY=` line inside a multi-line quoted value left alone; bare,
   single-quoted and refused values; every accepted value read back through
   Bun's `--env-file` in a child process equals the bytes written; every byte
   outside the edited line is unchanged.
4. **Caller** (`caller.test.ts`): the seat; an MCP-spawned agent whose launcher
   is the seat; a grandchild; a stage of a pipeline the seat created; a lineage
   edge naming the seat with no launcher → refused; a pipeline with no source
   conversation → refused; another project's seat; a child of a rotated seat;
   the relay owner agent; a seat's parallel self.
5. **Agent routes** (`src/app/api/secret-requests/route.test.ts`): creation
   with a capability; a replay with the same key answers the same request and
   sends one notice; a changed argument under the same key is refused; the
   limits; staging; cancel by the requester and by another conversation; reads
   by the seat and by a launched agent; the peer surface does not route these
   paths.
6. **The value route and the canary**
   (`src/app/api/secret-requests/[id]/value/route.test.ts`): cross-origin, any
   spawn capability, a service claim, no session, a team member → refused with
   nothing written; the owner → written at mode 600 with umask 0 and umask 077;
   a body over 16 KiB, a JSON body, a stale revision, a second entry, an
   expired request → refused, file unchanged; `token` with a space and `line`
   with a control character → refused. **Canary:** a distinctive random value
   is entered, then searched for in the HTTP answer, every console line captured
   during the test, every row of the `secret-requests` collection and of the MCP
   receipt store, the outcome message text, the fake Telegram transport's
   payloads and the temporary directory outside the destination. It is found
   only in the destination file.
7. **Lost answers and crashes** (`write.test.ts`): the create's answer lost →
   one re-dispatch, one record, one notice; the entry's answer lost → the next
   read is `entered`, a repeated entry is refused; a stop after the temporary
   was written and before the rename → the temporary is removed and the request
   is pending; a stop after the rename → `entered`; a parent directory swapped
   for a link between the check and the open → refused, nothing outside the
   roots touched.
8. **Telegram** (`notice.test.ts` and a case in the bot's `applyUpdates`
   tests): one notice per request across replays and restarts; no absolute
   path and no purpose in the text; a reply to the notice reaching the bot's
   poller is stored without text, never returned by `telegram_bot_messages`,
   and deleted.
9. **The card** (`src/components/decisions/SecretRequestCard.dom.test.tsx`):
   the input is a password input with no React-held value; typing writes no
   `localStorage` key and no decision draft; no microphone; Save stays disabled
   until the format holds; the field is empty after Save and after a refusal;
   Decline posts the cancel; a request whose destination changed redraws the
   facts; a member session gets no `secretRequests` field and draws nothing.
10. **MCP** (`src/lib/mcp/secretRequest.test.ts`): both tools are listed with
    their schemas; `request_secret` is mutating and recoverable,
    `read_secret_request` is an optional-key read; the capability is forwarded;
    no answer shape contains a value field.
11. **Rendered evidence** through the existing drivers, no new driver: cases in
    `src/components/kanban/kanbanBoard.browser.test.tsx` for the seat column at
    1440 px and 800 px, and in
    `src/components/mobile/issue1671Evidence.browser.test.tsx` for the phone
    sheet at 390 px. States: pending (`file` and `env`), the eye open on a dummy
    value, saving, refused with a changed destination, the strip line count;
    each in en and uk, light and dark.

**Existing tests the build touches** (each adapts to the new catalog or field):
`src/lib/mcp/server.test.ts:540` and
`src/runtime-host/mcpRuntimeCompatibility.test.ts:30` (they compare against
`MCP_TOOL_NAMES` and follow it); `src/lib/mcp/answerSizes.test.ts:131,150`
(every tool gets a census case; the size fixtures may need the two new rows);
`src/lib/mcp/callCost.test.ts:85-111` (classification sets);
`src/lib/mcp/schemaParity.test.ts`; `src/components/decisions/DecisionColumn.dom.test.tsx`
(lists drawn from `initial` keep their shape; a read now may carry
`secretRequests`); `src/app/servedPayloadSecrets.test.ts` gains a case that
the built decisions answer holds no entered value. No existing test asserts the
behaviour this design changes.

## 14. Build plan

Review risk: **high** for every slice. This is a credential path that writes
files on the operator's machine from an agent's request. Each slice gets a
security-minded review; slices 1 and 2 are worth three review rounds. The
agent-facing tool ships last, so an agent can never create a request the
operator has no way to answer.

| Slice | Contents | Reachable by | Tests |
|---|---|---|---|
| 1. Core | `src/lib/secretRequests/`: types, the `secret-requests` collection, the caller rule, the destination resolver with the git check, the `.env` scanner and composer, the byte checks, the atomic writer and recovery. An exported private-area predicate in `src/lib/artifact/localFile.ts` and a per-project roots helper beside `knownProjectFileRoots` | Nothing | 1–4, 7 |
| 2. Operator side | `POST /api/secret-requests/<id>/value` and `/decline` behind `keysOwnerGate`; the `secretRequests` field on `decisionsGET`; the notices on the main poll and the team projection; `SecretRequestCard` and the shared field; the merged column; the deep link; en and uk strings. Lane: build → review → visual critic (fail edge to a UI fix stage) → publish | The owner, for requests created by tests | 6, 9, 11 |
| 3. Agent side | `request_secret`, `read_secret_request`, the agent routes, the outcome message, the hourly expiry sweep; one line in the seat's instructions: a secret is asked for with this tool, and never in chat | Seats and their agents | 5, 7, 10 |
| 4. Telegram | The notice; the poller's withholding and deletion of replies to it | The owner's chat | 8 |
| 5. As built | This document's «As built» section | — | — |

**Open pull requests on the same files**, checked 2026-11-25:

- #4466 changes `src/lib/artifact/localFile.ts` (evidence HTML reports). Slice 1
  exports a predicate from the same file and rebases on whichever lands first.
- #4434 changes `src/lib/prototypeReview/types.ts` and the Telegram sender for
  decision forms (no polls, new layout). Slice 4 uses `sendOwnerReview` without
  a `review` payload either way and rebases on it.
- #4416 rewrites `src/components/keys/KeysSection.tsx`. Slice 2 moves
  `ValueField` to a shared module, so it follows #4416 when that lands first;
  §11.2 depends on it.

## 15. Validation against the requirement

| Ask | Holds because |
|---|---|
| R1, an orchestrator asks over MCP | `request_secret` (§4), admitted for the seat (§5) |
| R2, secure entry in Delegatus | Owner-gated byte route, masked uncontrolled field, no drafts or dictation (§7.3, §8) |
| R3, written where the caller named | `file` and `env` destinations at the caller's path, inside allowed folders, atomic, mode 600 (§6) |
| R4, the agent never sees it | No agent-facing path carries it; canary test (§8.2, §13 test 6); the honest limit stated (§8.4) |
| R5, desktop, phone, Telegram notice | The Decisions column and sheet; notice without the value (§7) |
| R6, orchestrators and their agents; who and where shown | §5 rule and identity; card rows 2–3 |

What a reviewer should hold this design to: nothing in it lets a value reach a
place §8.2 lists, and nothing lets an agent choose a destination outside its own
project without the operator having listed that folder.

## 16. Deferred — not currently justified

- **Multi-line secrets** (PEM keys, JSON service accounts) and file upload: a
  masked multi-line field is not portable across browsers, and the requirement
  names a password.
- **A Settings editor for extra folders**: the environment variable covers it
  until the operator asks.
- **An owner's history page of secret requests**: the record and
  `read_secret_request` cover the audit for now.
- **Detecting the value in transcripts afterwards**: it would need the value or
  a fingerprint kept around, which this design avoids.
- **A separate operating-system user for agents**, the only real
  confidentiality from agents (§8.4).
- **Making the Viewer non-dumpable or locking the buffer in memory during the
  write**: the dumpable flag is process-wide and `sealProcessLinks`
  (`src/lib/selfUpdate/gatedTrash.ts:145`) already toggles it; sharing it needs
  a counter, for a millisecond window.
- **Agents launched by a seat that has since rotated**: they ask through the
  current seat.
- **Conversations the operator started by hand** as askers.
- **Withholding a reply that arrives as a relay request**: the relay wire drops
  the parent of a reply to a message Delegatus sent (§7.5), so there is nothing
  to match, and the value has already reached the hosted service.
- **Removing or rotating a written secret from Delegatus.**
- **Writing one entry to several destinations.**
- **A tool that runs a command with the secret in its environment.**
- **The form's alternatives** (§11) until the operator picks one.

## 17. Operator questions

The four questions are already in the open form on the task; this design does
not ask them again. It builds the recommended answers, and §11 says what each
other answer changes. One choice was settled here by default and is easy to
reverse: folders outside the project are allowed only when the operator lists
them in `LLV_SECRET_ROOTS`.

## Коротко для оператора

Агент (оркестратор або агент, якого він запустив) викликає `request_secret` і
називає мету та місце: файл у теці проєкту або рядок `NAME=` у `.env`. У
колонці «Рішення» на десктопі й телефоні з'являється картка: хто просить, куди
саме запише, що станеться з файлом, і приховане поле. У Telegram приходить
сповіщення без значення й без тексту агента. Після «Зберегти» Delegatus
перевіряє шлях ще раз, атомарно записує файл із правами 600 і повідомляє агенту
лише «збережено, куди, довжина». Значення не потрапляє в розмову, журнали,
квитанції чи Telegram. Чесне обмеження: агенти працюють від твого користувача,
тож агент із доступом до терміналу може прочитати записаний файл; картка про це
каже. Збірка — п'ять зрізів, інструмент для агентів вмикається останнім.
