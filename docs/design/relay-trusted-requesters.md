# Trusted relay requesters: a per-project list now, workspaces later

Status: revised for #3131 after the operator's decision of 2026-10-24. Design
only. Every code reference was checked against `main` at `97bdb94ea`. This
revision replaces the 2026-10-20 proposal merged in #3293; what changed is
listed in §1, and what that proposal had that is now cut is kept in §8.

## 0. Originating requirement

**The operator, 2026-10-24, decision form on the board task for this design,
comment verbatim:**

> Если рабочий просторы уже готови, э-э, или. Когда они будут готовы, то тогда
> можно сделать разделение по ещё и по про- по просторам. Если там будет
> изоляция, то можно теоретически подключать для каждого рабочего простора
> своего. Ну, свой для каждого рабочего простора, нет, для каждого проекта.
> Слушай, я даже не знаю, надо как-то сделать, чтобы, типа, когда будет простор,
> это тогда, типа. Если есть прост- простір для этого человека, да, по этому ID,
> то тогда он может в рамках этого простора делать что хочет. Ну, то есть так.
> Потому что там будет изоляция. А до этого, если у нас есть список...
> Доверенных користувачів, то тогда мы можем спокойно давать. Им права для всей
> машины, пока нет просторов. Дозволи можна... Ты говоришь, седьмой вопрос: я
> думаю, да, один проект. Только не один підтверджений запитувач. В каждом
> проекте может быть свои запитувачи. Я б, наверно, для. Проекта бы делал не.
> Это прям сложно, нужно продумать. Если ты, у тебя есть твой простір,. То ты,
> наверно, добавлять никого не можешь, ты всё равно нужно, чтобы могли добавлять
> пользования машины только, только владелец. А вот если есть простір и ты уже
> там в нём,. Ты доверенный користу- ну, ты его власник, по телеграму привязал.
> То ты, соответственно, можешь в рамках этого простора запускать. Ну вот, не
> знаю. А если другой человек, ну тоже, а если просторов много, он находится и в
> том, и в том, и в том. Ну тогда доступы есть просто куб. Тогда как бы своего
> рода изоляция должна работать так. Чтоб позволить в один из проектов любой.
> Подумай как-то так.

**The answers on the same form, 2026-10-24:**

| Question (numbering of the form) | Answer |
|---|---|
| Q4 When may a trusted non-owner start elevated runs? | (b) «Вже зараз, за списком довірених» — now, from a list of trusted requesters. |
| Q5 Who manages the list, and where? | (a) «Лише власник установки, з дошки або MCP, з підтвердженням і журналом» — only the installation owner, from the board or the MCP tool, with confirmation and an audit log. |
| Q6 What happens to targets the old switch enabled? | (b) «Залишити як є, вважати дозволом» — they stay enabled and count as a grant. |
| Q7 How broad is one grant? | (a), corrected in the comment: one project, and each project has its own set of requesters, which can hold several people. |

**The requirement this design answers, from the two together.** Before
workspaces exist, a requester on the owner's trusted list may start elevated
relay runs, and those runs have the rights of the whole machine. The list is
kept per project: each project has its own set of requesters. Only the
installation owner adds or removes people, from the board or the MCP tool, with
a confirmation and an audit log. Targets the old switch enabled keep working.
Once isolated workspaces exist, a person who belongs to a workspace and is
bound to it through Telegram may run anything inside that workspace; a person in
several workspaces has access in each, with isolation between them. Only the
machine's owner adds people to the machine.

The earlier requirement of #3131 (2026-10-20, paraphrased in #3293) asked for a
project-restricted boundary before any non-owner elevation. The 2026-10-24
answers replace that one decision (rule 13: a later answer replaces only what it
names). The parts it does not name still stand: the owner manages the list from
both surfaces, changes are audited, a message to the clone alone grants nothing,
and each run shows who triggered it.

## 1. What changed from #3293

| #3293 (2026-10-20) | This revision |
|---|---|
| No non-owner elevation until a project execution boundary, workspace slice (b) and the MCP fence (c) exist. | Phase 1 ships now: trusted non-owners get elevated runs with whole-machine reach. The boundary becomes the entry condition of phase 2 (§5.1). |
| Existing `ownerTier` targets blocked until reviewed. | They keep working: the switch reads as a paired-owner entry on that target (§4.4). |
| A separate policy file, a second per-target switch and an explicit refusal reason negotiated with the service. | Entries live on the target record that every authority check already reads; the entry list itself is the switch; people not on the list get today's ordinary answer (§4.2, §8). |
| "The grant follows the project across targets." | Not possible: the service's requester key is per target (`docs/design/relay.md:1482`). An entry is per project and per target (§4.1). |
| Enrolment by picking an observed requester. | A one-time code the person sends to the clone (§4.5); a display name proves nothing. |
| Management confirmation designed from scratch. | Reuses the voice-tools pattern: MCP proposes, the Telegram-signed-in paired owner approves in the browser (§4.6). |

## 2. The two phases at a glance

| | Phase 1: trusted list (build now) | Phase 2: isolated workspaces (after §5.1 holds) |
|---|---|---|
| Who may start an elevated run | A requester on the target's entry list for the target's project, or the paired owner where an entry for them exists. | Phase 1's entries, plus every member of the workspace that holds the target's project whose relay key is linked to their Delegatus member (§5.2) and whom the machine owner has admitted (Q2, Q3). |
| What the run can reach | Everything the installation's OS user can reach: every project, credential and host. The agent's Viewer tools are as today's owner turn's; a seat handoff goes only to the entry's project (§4.7). | Only the workspace: its checkouts, accounts, credentials and hosts, enforced below the shell (§5.1). |
| Who adds people | The installation owner only. | The installation owner only (Q3 settles what a workspace manager's invite does). |
| Identity | The service's opaque per-target requester key, enrolled by a one-time code. | The same key, linked to a member who signed in with Telegram. |

The phases share one decision function, one entry store, one confirmation path
and one audit log. Phase 2 adds a second source of admission (workspace
membership) and a narrower place to run; it removes nothing from phase 1.

## 3. Current code and state (checked at `97bdb94ea`)

| Boundary | What the code does today | Change |
|---|---|---|
| Elevation selection | `src/lib/externalRelay/profile.ts:14-21`: `ownerTierFor` returns an owner instruction only when `target.ownerTier === true`, `requester.is_owner === true`, `is_anonymous_admin === false`, and the `respond_to` message is authored by `requester.key` and not by the clone. | Becomes `elevatedRequesterFor(target, request)` (§4.2). The strict wire checks stay. |
| What `is_owner` means | `docs/design/relay-owner-tier.md:100-107`: the service sets it when the author is the person who confirmed the pairing. | A paired-owner entry keeps that meaning (§4.4). |
| Requester identity | `src/lib/externalRelay/protocol.ts:117-124`: six fields, `key` plus five service booleans. `docs/design/relay.md:1482`: `author.key` is opaque and stable per target, and the service must not send platform user ids. `src/lib/externalRelay/protocol.ts:101-113`: each message also carries `author.name`, a display name. | One person has a different key on each clone. Entries are per target; a display name never matches anything. |
| Target settings | `src/lib/externalRelay/store.ts:10-26`: `project` and the optional `ownerTier` switch. Written by `src/app/api/external-relay/relays/[id]/route.ts:21-117` (allowed keys at `:50`, `ownerTier` validated at `:97`). The guard `src/lib/externalRelay/routeGuard.ts:9-23` refuses agents and cross-origin calls; it does not check who the person is. | The PATCH route stops accepting `ownerTier`. Entries get their own owner-only route (§4.6). |
| Other writers of the target list | `src/lib/externalRelay/store.ts:511-527` (`mergeRelayTargets`, poller refresh at `src/lib/externalRelay/poller.ts:285-296`) keeps every local field of a kept target and drops a target the service no longer lists. `src/app/api/external-relay/relays/[id]/targets/[targetId]/route.ts:46-60` spreads the kept item. `src/lib/externalRelay/pairing.ts:85` builds a new pairing's targets from scratch. | Entries survive refreshes and routing edits; a dropped target loses them; a new pairing starts with none. This is the wanted behaviour, and slice 1's tests pin it. |
| Admission | `src/lib/externalRelay/runner.ts:571-579`: the prototype path tests the owner with the switch forced on, then `owner = … ownerTierFor(target, request)`. `:590` derives the conversation authority. `:601-603` picks the account from `target.project`. `:629-632` writes `ownerTurn` into the run record. | The decision runs at `:578`; the run record carries the matched entry (§4.3). The prototype path stays paired-owner only. |
| Durable authority | `src/lib/externalRelay/store.ts:103`: the `ownerTurn` record. `src/lib/externalRelay/ownerAuthority.ts:22-36`, `:80-91`, `:96-110`, `:113-121`, `:126-135` recheck `target.ownerTier === true` at live lookup, reply, async MCP, recovery and continuation. | Each recheck tests the run's entry instead (§4.3). They already read `relays.json`, so no new read is added. |
| Revocation | `src/lib/i18n/en.ts:345` promises that switching off "stops active and pending owner turns and blocks their replies at once"; `src/lib/externalRelay/ownerRun.ts:379-410` retires the queued first prompt and held deliveries ("owner relay turn revoked"). | Removing an entry fails the same rechecks and reuses this path. |
| Conversation reuse | `src/lib/externalRelay/conversations.ts:213-214` maps elevation to authority `owner-tier`; `:272` matches a pin on requester key, authority and engine. | A requester entry gets authority `trusted:<entry id>` (§4.3). |
| Launch | `src/lib/externalRelay/ownerRun.ts:60` builds the owner prompt (text at `:91`); `:813-814` launches in the OS user's home with title `Relay · <target>`. | Same launch; prompt wording and title name the trusted requester (§4.7). |
| Seat handoff | `src/lib/externalRelay/ownerAuthority.ts:40-48` wraps the request as "The install owner delegated this request … carries operator authority"; `:52-60` constrains the project only when a bridge report is attached. | For a requester entry the wording names the requester, and the project check applies to every handoff (§4.7). |
| Other readers of the switch | `src/lib/externalRelay/ownerDestination.ts:24` prefers a target with `ownerTier` when picking the owner's review destination. `src/lib/transfer/sections.ts:127` and `:290` export `ownerTier` with a target's settings. `src/components/externalRelay/ExternalRelaySection.tsx:481` and `:519-524` draw the switch; `src/lib/i18n/en.ts:344-346` and `src/lib/i18n/uk.ts:343-345` its text. | `ownerDestination` prefers a target with a paired-owner entry. Transfer carries paired-owner entries as it carries the switch today and never carries requester entries or links. The switch row becomes the entry list (§4.8). |
| Owner proof | `src/lib/team/actor.ts:52-59` (`authenticatedOwner`): a live Telegram session of a member with role `owner` whose Telegram id equals the paired owner's. Used by `src/app/api/telegram/bot/confirmation/route.ts:18-24` and `src/lib/voiceTools/http.ts:12-20`. `src/lib/team/http.ts:59-64` (`requireOwner`) checks the team role only. | Entry writes use `authenticatedOwner`, the stronger of the two (§4.6). |
| Propose-then-approve | `src/lib/voiceTools/http.ts:29`: the MCP side may only `list`, `status` and `propose`; approval happens in the browser. `src/lib/telegram/bot/fileConfirmations.ts:58-67`: a confirmation link with a ten-minute expiry. | The MCP tool follows the same split (§4.6). |
| Workspaces | `src/lib/team/workspaces.ts:26-28`: slice (a) is a filter and restricts nothing. Slice (b), membership and the human route gate (including owner-only relay routes), is open as #3255. The MCP fence, slice (c), is not started. `docs/design/workspaces.md:249`: level 2 leaves the agent's shell unrestricted; `:286` names level 4 as the only level that contains a workspace's agent; `:447` lets a manager invite people into a workspace. | Phase 2 depends on (b), (c) and an execution boundary (§5.1). |

## 4. Phase 1: the trusted list

### 4.1 What an entry is

An entry lives on the relay target record in `relays.json`, under
`requesters: { revision, entries[] }`. Each entry has:

- `id`, unique and never reused; removing and re-adding creates a new id;
- `kind`: `paired-owner` (matches the request whose `is_owner` is true) or
  `requester` (matches one requester key);
- `key`, for `requester` entries only: the opaque per-target key the
  enrolment code proved (§4.5);
- `project`: the canonical project key the entry was granted for;
- `label`: the owner's local name for the person, unique on the target;
- `addedAt`, and `source`: `board`, `mcp` or `earlier-switch`.

Entries sit on the target because the requester key exists only per target
(`docs/design/relay.md:1482`), and because every authority recheck already reads
this file. The project's set of requesters is the union of the entries on the
targets routed to that project; the board shows it per target, under the
project the target names. An entry matches only while the target's canonical
project equals the entry's `project`: routing a target to another project
suspends its entries until the owner re-adds people there, so trust granted for
one project never moves to another. Entries are capped at 50 per target, which
bounds what the synchronous rechecks read.

### 4.2 The decision

`elevatedRequesterFor(target, request)` returns an instruction and the matched
entry, or nothing:

1. The wire checks of `profile.ts:16-19` hold: a requester block, a nonempty
   key, `is_anonymous_admin === false`, and a `respond_to` message authored by
   that key and not by the clone. Message text, history, forwarded messages,
   display names and chat titles grant nothing.
2. The relay is not paused and the target is enabled.
3. An entry on this target matches: `paired-owner` when `is_owner === true`;
   `requester` when the key is equal. Its `project` equals the canonical form
   of `target.project`. A `requester` entry needs a non-null project; a
   `paired-owner` entry carried from the old switch may hold `null` and then
   matches only while the target has no project, as today.

A request that matches nothing gets today's restricted answer, exactly as a
non-owner does on a switched-on target now. No refusal reason is added to the
wire, and nobody outside learns who is on the list.

The prototype path (`runner.ts:571-577`, `:632`) stays as it is: only the
service-identified paired owner can answer a prototype review.

### 4.3 Binding a run to its entry

The run record's `ownerTurn` gains `entry: { id, kind, project, label }`,
written before the run is reserved, as `ownerTurn` is today. Every recheck in
`ownerAuthority.ts` replaces `target.ownerTier === true` with "the entry with
this id is still on this target and still matches the target's project". A run
recorded before the upgrade has no `entry` and is read as the target's
paired-owner entry, so a running owner turn keeps its authority across the
deploy.

Removing an entry fails the next recheck, and the existing revocation path
stops the turn, retires its queued first prompt and blocks its replies
(`ownerRun.ts:379-410`). An unrelated edit (another entry, the target's model)
leaves a running turn alone, because the recheck looks for its own entry id. A
removed and re-added person gets a new id, so an old run or pin does not revive.

Reply-chain reuse keeps the paired owner on authority `owner-tier`, so existing
pins continue. A `requester` entry uses `trusted:<entry id>`, so two requesters
never share a conversation and a re-added person starts a fresh one.

### 4.4 Targets the old switch enabled

No migration step runs at startup. A target whose record still has
`ownerTier: true` is read as carrying one `paired-owner` entry with the id
`earlier-switch-<target id>`, source `earlier-switch`, and the target's current
project. The first entry write on that target stores the entry explicitly,
drops `ownerTier`, and writes an audit row saying it came from the earlier
switch. Until then nothing on disk changes, so a rollback to the previous
release finds the switch where it left it. The board shows the entry as
"Paired owner (from the earlier switch)", and the owner can remove it like any
other.

For a new target the paired owner adds themselves with one press ("Add me");
`is_owner` already identifies them, so no code is needed.

### 4.5 Enrolling a person

A requester key cannot be typed or looked up: it is opaque, per target, and the
service never sends a platform id. A display name is chosen by its holder and
can copy anyone's. So enrolment proves the key by a message:

1. The owner, signed in, opens the target, presses "Add person" and types a
   label. The project must be set. The server creates a pending enrolment bound
   to relay, target, label and the owner's session: a short single-use code,
   valid ten minutes, at most one per target. Pending enrolments are held in
   the Viewer's memory, as file-send confirmations are; a restart drops them
   and the owner starts again.
2. The owner gives the person the code. The person sends it to the clone,
   preferably in a private chat with it.
3. The runner checks pending codes before choosing a profile, only while one
   exists for that target. When the triggering message's text equals the code,
   it records the author key, chat, display name and time on the pending
   enrolment, answers with a fixed line ("Code received. The owner will
   confirm."), and runs no agent.
4. The owner sees the candidate (display name, chat title, time) and confirms.
   The entry and its audit row are written together (§4.6).

A code someone else sends first yields a candidate the owner can see is wrong
and decline; the code is then spent and a new one is needed.

### 4.6 Management: board and MCP, confirmation, audit

One server module writes entries; two surfaces call it.

- **Board.** The target's settings block lists its entries with label, kind,
  project, added time and state (active, or suspended because the target moved
  to another project). Add, Add me and Remove act in place. Every write checks
  `authenticatedOwner(req, ownerReviewDestination().chatId)`, the check file
  sends and voice tools use: a live Telegram session of the team owner whose
  Telegram id is the paired owner's. A teammate's session, a bearer-key script
  or an agent cannot pass it. An install where nobody has signed in that way
  can list entries and cannot change them, as with voice tools today. Each write shows a confirmation naming the
  person, the target, the project and, for a `requester` entry, the reach:
  "Until isolated workspaces exist, this person's runs can read and change
  everything this computer's account can: every project, its credentials and
  its hosts."
- **MCP.** `relay_trusted_requesters` with `list`, `start_enrolment`
  (relay, target, label) and `remove` (entry id). Like voice tools
  (`voiceTools/http.ts:29`), the tool never writes: `start_enrolment` returns
  the code and a confirmation link, and `remove` returns a confirmation link.
  The owner opens the link in the browser, where the same owner check and
  confirmation apply. A link is single-use, bound to the operation and the
  target's `requesters.revision`, and expires after ten minutes; a stale
  revision refuses and asks for a new link. Every operation is refused to a
  conversation that is itself a relay run (`liveOwnerRelayConversation`,
  `ownerAuthority.ts:13`), so a trusted requester's agent cannot list the
  people or propose one.
- **Audit.** `<state>/external-relay/trusted-requesters-audit.jsonl`, mode
  0600, append-only. One row per add, remove, earlier-switch materialisation,
  declined confirmation and expired code: time, action, relay, target, project,
  entry id, label, surface, proposing conversation (MCP), approving owner
  member id, and revision before and after. The row is appended and synced
  under the `relays.json` lock before the store is replaced; if the append
  fails, the entry is not written. The board shows the target's history from
  this file. It holds no requester key, platform id or chat text.

Phase 1 trust is machine-wide, and the confirmation and audit should be read
with that in mind. They stop a mistaken click and an agent that tries to act for
the owner. They do not stop a trusted requester's own agent, which runs as the
installation's OS user and can edit `relays.json` or the audit file directly.
The confirmation text says so in plain words, and §6 tests nothing that phase 1
cannot keep.

### 4.7 What the run says about itself

- Title: `Relay · <target>` for the paired owner, as today;
  `Relay · <target> · <label>` for a requester entry (`ownerRun.ts:814`). The
  run's record keeps the label from admission, so a later rename or removal
  does not rewrite history.
- Prompt (`ownerRun.ts:91`) and seat directive (`ownerAuthority.ts:45`): for a
  requester entry, "the owner" becomes "<label>, a trusted requester for project
  <project>", and "carries operator authority" becomes "carries this trusted
  requester's authority for project <project>".
- Seat handoff: `ownerRelayTargetMatches` (`ownerAuthority.ts:52-60`) already
  refuses a bridge-report handoff to another project; for a requester entry it
  refuses every handoff whose project differs from the entry's. This keeps the
  per-project sets meaningful at the Viewer: a person trusted on project A
  cannot direct project B's seat in the owner's name. It is a guard against
  mistakes; the shell can still reach project B in phase 1.
- Unchanged: the service decides which chat tools a requester gets, from its own
  role flags; a local entry never sets `is_owner` and unlocks no owner-audience
  service tool. Account choice still follows `target.project`
  (`runner.ts:601-603`). The per-member hourly limit (`profile.ts:37-38`) still
  counts a trusted requester who is not a chat admin.

### 4.8 Board surface

The switch row "Full agent for the owner" in `ExternalRelaySection.tsx:519-524`
becomes "Trusted requesters" with the list, Add person and Add me, in the same
settings block (no new screen, per the project's reuse rule). The caption at
`:481` reads "N trusted" when entries exist. Strings land in `en.ts` and
`uk.ts`. The rendered evidence goes through the existing drivers named in
`AGENTS.md`, in en and uk, light and dark, desktop and phone, with the states
empty, one paired owner from the earlier switch, two people with entries, a
suspended entry, a pending code and a candidate awaiting confirmation.

## 5. Phase 2: isolated workspaces

### 5.1 What must be true before a workspace member gets unrestricted runs

The operator's model gives workspace members unrestricted runs "because there
will be isolation". The workspace level chosen on 2026-10-20, level 2, isolates
attention and the Viewer's tools; it leaves the agent's shell running as the
installation's OS user with every checkout and credential readable
(`docs/design/workspaces.md:249`). Level 2 alone therefore cannot carry phase 2.
Phase 2 starts for a workspace only when all of these hold for that workspace,
each shown by a test that tries to break it:

1. **Membership exists.** Workspace slice (b) has merged (#3255 is open), and
   membership is checked live on every request.
2. **The Viewer's tools are fenced.** Slice (c), the MCP fence, refuses any
   tool call or handoff naming a project outside the run's workspace.
3. **The shell is contained.** The run's processes run under an OS identity (a
   user or container per workspace; level 4 at `docs/design/workspaces.md:277-290`
   is one way) that can read and write only that workspace's checkouts,
   transcripts and state. Absolute paths, `..`, symlinks, `/proc` of other
   processes and inherited file descriptors do not reach another workspace or
   the operator's home.
4. **Credentials and hosts are the workspace's.** Engine accounts, `gh`
   credentials, SSH keys and agents, cloud identities and the environment
   handed to the run are the workspace's own. No socket, helper or proxy back
   into the operator's account is reachable.
5. **Every path keeps the boundary.** Children, continuations, recovered runs,
   relay replies and seat handoffs start inside the same boundary. The run
   records which boundary it ran in, and a recheck after restart refuses
   authority on a mismatch.

How the boundary is built (one installation per workspace, or one installation
starting agents under per-workspace users) is the subject of its own design.
Q1 asks whether the operator wants this bar or accepts level 2.

### 5.2 Binding a relay requester to a member through Telegram

A member signs in to Delegatus with Telegram (`src/lib/team/telegramSignIn.ts`),
which proves their Telegram account. The relay never sends that account's id,
so the link from a relay key to the member uses the code of §4.5, started by
the member in their own session: "Link my Telegram chats with <clone>". The
member sends the code to the clone and confirms the candidate. The link records
(relay, target, key) → member id, appears in the owner's audit log, and grants
nothing by itself. A member who uses two clones links twice, because the key
differs per clone. Removing the member, or the member unlinking, ends the link.

### 5.3 The decision in phase 2

For a request on target T, with project P = the canonical project of T and W =
the workspace that holds P:

1. Phase 1's wire checks (§4.2 steps 1-2).
2. If W is isolated (§5.1) and the key is linked to a member who holds a
   qualifying role in W (Q2) and was admitted by the machine owner (Q3): run
   inside W's boundary with W's fence.
3. Else, if an entry on T matches (§4.2 step 3): run inside W's boundary when W
   is isolated, and machine-wide when it is not (Q4).
4. Else the restricted answer.

The workspace comes from T's configured project, never from the message, the
chat or an earlier conversation. Run binding, rechecks and revocation are
phase 1's (§4.3), with membership added to what each recheck reads: removing a
member from W stops their workspace-admitted runs the same way removing an
entry does. Membership, unlike entries, lives in the team store, so the
recheck reads it from the team store's in-memory snapshot, never by a new
synchronous file read on the relay path.

### 5.4 Per-project sets and workspace membership

Inside an isolated workspace, membership covers every project in it: "в рамках
этого простора делать что хочет". The per-project sets keep doing what they do
in phase 1 for people who are not members: the owner can trust a person on one
project of W without making them a member of W, and that person's runs are
contained in W's boundary like everyone else's.

### 5.5 A person in several workspaces

Each clone routes to one project, and each project sits in one workspace, so
each request runs in exactly one workspace. A member of W1 and W2 who writes to
a clone routed to a W1 project runs inside W1; the same person writing to a
clone routed to a W2 project runs inside W2. The two runs share no files,
credentials or conversation pins (the pin's authority names the workspace), and
the fence refuses a W1 run's handoff to a W2 seat even though the person
belongs to both. A clone that serves several workspaces would make the
workspace depend on the message, so it is not offered (§8).

### 5.6 Who adds people

The machine owner alone adds entries (phase 1) and admits members to relay
elevation (phase 2). The workspace decision of 2026-10-20 let a workspace
manager invite people into a workspace (`docs/design/workspaces.md:447`); the
2026-10-24 comment says only the machine owner adds people to the machine. Both
can hold if a manager's invite still gives Viewer membership and the owner's
confirmation is what turns on relay elevation for that member. Q3 asks this.

### 5.7 The transition for existing list entries

When a workspace becomes isolated, nothing is converted and nothing is widened:

- An entry on a project in that workspace keeps admitting its person, and from
  that moment their runs start inside the workspace's boundary. Their reach
  narrows from the whole machine to the workspace, which is what isolation is
  for.
- The owner gets one review list for the workspace: each such entry with
  "Keep as a project entry", "Make a member of the workspace" (an invite the
  person accepts) or "Remove". Until the owner answers, the entry keeps working
  in its narrowed form.
- Entries on projects outside any isolated workspace (Unassigned, or a
  workspace without a boundary) keep phase 1's machine-wide reach unless Q4 is
  answered otherwise.
- Paired-owner entries are unchanged: the owner's runs keep the owner's reach.

## 6. Delivery slices and acceptance

### Slice 1: entries, decision and rechecks (phase 1 core)

`elevatedRequesterFor`, the entry schema on the target, the earlier-switch
reading, the run's `entry`, every recheck in `ownerAuthority.ts`, conversation
authority, prompt and title wording, the handoff project check, the
`ownerDestination` preference, the transfer rule and the PATCH route refusing
`ownerTier`.

Acceptance, each as a test run by file path with isolated state:

- A target with `ownerTier: true` and no entries elevates the paired owner and
  nobody else, before and after the first entry write; the materialised entry
  carries source `earlier-switch` and one audit row.
- A `requester` entry elevates exactly that key on that target; the same key on
  another target, the right key with `is_anonymous_admin: true`, a mismatched
  `respond_to` author, a message by the clone, and a display name equal to the
  label all get the restricted answer.
- Routing the target to another project suspends its entries; routing it back
  restores them.
- Removing an entry during a queued spawn, a running turn, a continuation and an
  async MCP call stops the turn through the existing path and blocks its reply;
  editing another entry leaves the turn running. A run recorded before the
  upgrade keeps its authority.
- A requester entry's seat handoff to another project is refused; to its own
  project it is delivered.
- Poller refresh and the routing PATCH keep entries; a target the service drops
  loses them; a new pairing has none; transfer export carries no requester entry.

### Slice 2: enrolment, management and audit

The code flow in the runner, the owner-only route, the MCP tool, the
confirmation page, the audit file and the board list.

Acceptance: an owner adds a person through the board and through an MCP link,
and both write one entry and one audit row. A teammate's session, a bearer-key
request, an agent conversation and a relay-run conversation are refused on both
surfaces. A stale revision, an expired or reused link, a declined confirmation
and an audit append failure write no entry. A code sent by the wrong person
yields a candidate the owner can decline, and the spent code admits nobody.
Rendered evidence through the existing drivers covers the states of §4.8.

### Slice 3: phase 2, per workspace

Starts only when §5.1's five conditions hold for a workspace and Q1-Q4 are
answered. Member linking, the membership source of admission, running inside
the workspace boundary, the review list of §5.7, and the threat tests: from a
direct run, a continuation, a recovered run, a child and a handoff, try to read
another workspace's checkout and credentials, the operator's home and an
unrelated host, through absolute paths, `..`, symlinks and inherited secrets;
each fails without side effects.

## 7. Validation against the requirement

| The requirement says | Where |
|---|---|
| Trusted non-owners may run elevated now, from a list | §4.2, slice 1 |
| They get rights for the whole machine while there are no workspaces | §2, §4.6 (the confirmation says so), §4.7 |
| Each project has its own set of requesters | §4.1 (entries bound to a project; moving a target suspends them), §4.7 (handoff check) |
| Only the installation owner manages it, from the board or MCP, with confirmation and an audit log | §4.6 |
| Targets the old switch enabled stay enabled and count as a grant | §4.4 |
| With isolated workspaces, a member bound through Telegram may run anything inside their workspace | §5.1-§5.3 |
| Only the machine owner adds people to the machine | §4.6, §5.6, Q3 |
| A person in several workspaces has access in each, isolated from each other | §5.5 |
| Still standing from #3131: a message alone grants nothing; each run shows who triggered it | §4.2 step 1, §4.5, §4.7 |

## 8. Deferred — not currently justified

- **A project execution boundary for phase 1.** #3293 required one before any
  non-owner elevation. The operator chose machine-wide trust until workspaces;
  the boundary moves to phase 2 (§5.1).
- **An explicit wire refusal (`requester_not_trusted`) and capability
  negotiation.** People not on the list get today's restricted answer, which
  needs no protocol change and discloses nothing.
- **A second per-target "Allow elevated runs" switch.** The entry list is the
  switch; an empty list is off.
- **A separate policy file with its own lock and idempotency receipts.** Entries
  on the target reuse the store, lock and atomic write every recheck already
  reads.
- **Enrolment by picking a requester seen in recent requests.** Display names
  are chosen by their holders; the code proves the key (§4.5).
- **A cross-target identity from the service** (a stable per-pairing user key,
  or an attested platform id). It would let one enrolment cover all of a
  project's clones, and needs a service change the relay protocol currently
  forbids (`docs/design/relay.md:1482`).
- **Wildcard, role-based ("every chat admin") and expiring entries.**
- **A clone serving several workspaces**, which would choose the workspace from
  the message (§5.5).
- **Public-export aliases for requesters and team-activity projection of the
  audit.** The audit holds no identities to alias, and the board's history view
  covers solo and team installs alike.
- **An implicit trust of the paired owner on new targets.** One press adds them
  (§4.4); nothing is trusted without an entry.

## 9. Questions for the operator

1. **What isolation must a workspace have before its members get unrestricted
   relay runs?** Level 2, chosen on 2026-10-20, leaves the shell able to read
   every project and credential, so "can do anything inside the workspace"
   would in fact reach the whole machine. Recommended: require a per-workspace
   OS identity that contains the shell, credentials and hosts (§5.1, level 4 or
   an equivalent executor); until a workspace has it, its members use phase 1's
   list like anyone else.
2. **Which workspace roles get unrestricted runs?** Recommended: every member
   and manager of the workspace, because members already direct agents there
   from the board, and the relay is one more way to do the same.
3. **Can a workspace manager's invite turn on relay elevation?** The 2026-10-20
   decision lets managers invite people into a workspace; the 2026-10-24 comment
   says only the machine owner adds people to the machine. Recommended: a
   manager's invite gives Viewer membership as decided; relay elevation for that
   member starts only after the machine owner confirms it once, with the same
   confirmation and audit as a list entry.
4. **After isolated workspaces exist, do list entries on projects outside them
   keep whole-machine reach?** Recommended: yes, for projects in Unassigned or
   in a workspace without a boundary, managed and warned as in phase 1; entries
   on isolated projects narrow to the workspace automatically (§5.7).
5. **Is a one-time code acceptable for adding a person?** The person sends a
   short code to the clone and the owner confirms who sent it (§4.5); this is
   the only way to tell people apart, since the relay gives each person an
   opaque key per clone and names prove nothing. Recommended: yes, and the
   same code links a member's Telegram chats in phase 2.
