# Worker limit: one machine default, an optional limit per project

## Originating requirement

The operator, 2026-10-12 about 05:55 Kyiv time, to the Delegatus orchestrator
seat (voice, Russian), verbatim:

> «Нам нужно какое-то в настройках лимит, чтобы можно было быстро и мне, и
> агенту его изменять, то есть настройка для всей машины по количеству
> параллельных воркеров. Э-э, на каждый проект. То есть на каждый проект у нас
> там лимит воркеров, по-моему. Сейчас стоит, да, видишь, и каждый раз он там
> 3, он слишком мало. Я бы хотел это глобально для машины можно было менять в
> одном месте.»

The screenshot sent with it shows another project's orchestrator answering
"this takes the third of three available slots". That 3 is the shipped
default of the mandate (§1).

Addition, the operator about 06:00Z the same day, relayed by the orchestrator
(quoted as relayed, with its elisions):

> «нужно как-то красивенько … показывать лимит агентов … Один глобальный
> лимит, а другой локальный лимит на проект, наверное, да? Или у нас как-то
> это уже учитывается?»

The orchestrator turned the addition into these requirements: a machine-wide
default, «parallel workers per project», set in one settings place; an optional
per-project override set from that project's existing settings or seat surface,
shown as «з глобальних N» when unset and «свій ліміт M» when set; each
project's limit and current usage shown neatly where the operator already
looks, for example «воркери 7 / 10», with its source visible; agents read and
change both levels through the tool, with audit records; and the brief says
whether a per-project limit exists today and how it is counted.

Acceptance, from the pinned specification:

- One machine-wide setting, stored once in Delegatus state, applied to every
  project's orchestrator: in the mandate's worker line and in anything else
  that counts or enforces worker slots.
- Edited in one place in the existing settings UI, in an existing section, with
  no new panel. An agent reads and changes it through an MCP tool or an
  existing settings tool. Every change records who, from what value to what,
  and why.
- The global value is the default, and the UI shows when a project overrides
  it.
- A running seat picks up a change without a rotation (the next wake reads the
  current value), and the mandate text stays truthful.
- Bounds 1…64. The current number of running workers shows next to it.
- Tests: the default, a change through the UI and through the tool, a project
  override, the mandate line rendering the current value, audit records.
- Rendered evidence at 1440 and 390 px, uk and en, light and dark.

## 1. Where the limit comes from today

**Does a per-project limit exist today?** No. Nothing stores a worker
number for a project, and nothing counts running workers against any
number. The limit exists only as prompt text, delivered once when a seat
starts:

| Place | What it holds |
| --- | --- |
| `src/lib/roles/defaults.ts:180` | Orchestrator role parameter `maxWorkers`: integer, default 3, min 1, max 20. |
| `src/lib/roles/defaults.ts:188` | Orchestrator scaffold: "In every mode, keep at most {{maxWorkers}} workers running at once: each running lane and each live spawned agent counts as one." `renderScaffold` (`src/lib/roles/registry.ts:90`) substitutes the parameter. |
| `src/lib/orchestrator/prompt.ts:453` | Mandate (v45), "How work runs": "Keep no more workers running at once than your role parameters allow (3 when they name none), in every mode: …". |
| `src/lib/mcp/server.ts:395` | `MCP_BOUNDED_NUMERIC_ARGS.spawn_agent`: `roleParams.maxWorkers` clamped to 1…20, fallback 3. |
| `src/lib/i18n/en.ts:1328`, `uk.ts:1307` | Labels of the parameter; `DraftAgentPane.tsx:204` draws a field for it when a draft picks the orchestrator role. |
| `src/lib/orchestrator/seatCommand.ts:1155, 1264, 1596` | A seat launch or rotation passes `rawBody.roleParams`, else `{ mode: "standard" }`. The value is rendered into the seat's **first prompt** and stored nowhere: the seat record (`seats.ts`) keeps no role parameters, `create_orchestrator` and `rotate_orchestrator` name none, and every rotation without them starts the successor at 3. |
| Seat memory | This project's 30 lives only in a seat memory note. |
| `docs/design/agent-prompt-contract.md:777, 1037` | Quotes both texts. |

The closest thing to a per-project limit is that launch-time
`roleParams.maxWorkers`. It applies to one seat launch, nobody can read it
afterwards, and the next rotation loses it.

**How workers are counted today.** By the seat itself, from the mandate's
words "each running lane and each live spawned agent counts as one". No code
counts against the cap, and nothing refuses a launch past it: on the morning
of the request one seat had about 22 lanes running at once. Two places count
running work for other purposes, and this design reuses their definitions
without changing them: the seat tick treats a non-terminal lane and a running
seat-spawned child as open work (`src/lib/monitor/seatTick.ts:184, 224`;
`isOpen` in `seatTickSources.ts:866`), and agent memory budgeting counts live
structured hosts (`src/lib/runtime/agentMemory.ts`,
`structuredSpawn.ts:1758`).

Not a cap, left alone: the `update_task` hold kind `worker` (text about
waiting for a slot, `docs/design/task-states-and-reasons.md:140`) and the seat
tick's interval eligibility (`src/lib/monitor/cards.ts:23`).

So there is nothing to keep. The design adds the two levels once and retires
the launch parameter (§6), which leaves no second mechanism running in
parallel.

Prior conversations: the transcript search found the request itself and a
seat asking on 2026-10-03 whether to keep 3 or return to 30. Nobody had
designed a stored limit. Memory search returned nothing.

## 2. Storage

One new state file, `worker-limit.json`, holds both levels and their history:

```json
{
  "schemaVersion": 1,
  "machine": { "value": 8, "changedAt": "<ISO>", "changedBy": { … }, "reason": null },
  "projects": {
    "<canonical project key>": { "value": 10, "changedAt": "<ISO>", "changedBy": { … }, "reason": "<text>" }
  },
  "history": [
    { "at": "<ISO>", "scope": "machine", "project": null, "from": 3, "to": 8, "by": { … }, "reason": null, "clientRequestId": null },
    { "at": "<ISO>", "scope": "project", "project": "<key>", "from": null, "to": 10, "by": { … }, "reason": "<text>", "clientRequestId": "<id>" }
  ]
}
```

`changedBy` and `by` are `{ kind: "operator" | "manager" | "gateway",
conversationId, project, via }`. On a project entry, `from: null` and
`to: null` mean "inherits the machine value".

- **Effective limit of a project** = its own entry, else the machine value,
  else the shipped default 3. The source is `"project"`, `"machine"` or
  `"default"`. Project entries are keyed by `canonicalProject(key)` and read
  canonical-then-raw, as `src/lib/projects/settings.ts` does, so a folder
  whose key moved (AGENTS.md, succession) keeps its limit.
- **Bounds.** Integers 1…64 at both levels. A write outside them is refused
  with the bounds named and nothing is stored. It is never clamped, because
  this is an operator setting. On read, an absent or malformed file, or a value
  outside the bounds, falls back to the next level (with `unreadable: true`
  when a file exists but did not parse).
- **Write.** Under `withFileTransactionSync(file, …)` from
  `src/lib/state/fileTransaction.ts`: read, compare, append the history entry,
  write atomically (temp file plus rename, mode 0600). A write that changes
  nothing answers `changed: false` and records nothing. The lock makes `from`
  truthful when the Viewer and an MCP process write at the same moment.
- **Audit.** The history is the record. It keeps the newest 500 entries; at a
  few changes a month that is years.
- **Read.** mtime-and-size cached, so every wake, status poll and tool answer
  costs one `stat`.
- **Module.** `src/lib/operator/workerLimit.ts`: `readWorkerLimits()`,
  `effectiveWorkerLimit(project)` → `{ value, source, machine }`,
  `setMachineWorkerLimit(value | null, actor, reason, requestId)`,
  `setProjectWorkerLimit(project, value | null, actor, reason, requestId)`,
  and `WORKER_LIMIT_DEFAULT = 3`, `MIN = 1`, `MAX = 64`.

Why one file of its own and not the existing stores:

- `project-settings.json` is the existing per-project store, and the obvious
  candidate for the override. But its entries keep only `changedAt` and
  `changedBy`, with no reason and no history. Its reader drops fields it does
  not know (`entryOf`), so after a rollback an older build would erase every
  override on its next merge-switch write. And writing the override there
  with the record somewhere else would split one change across two files. The
  override is edited from the seat header, not from the project menu, so
  nothing in the UI ties it to that store either.
- `operator-settings.json`: its writer also rebuilds the body from the fields
  it knows, and the browser writes it with an unlocked read-modify-write.
- `role-presets.json` is schema-versioned. A new field means schema 6, which an
  older build refuses, so a rollback would disturb every role mapping.

State ownership: resolved through `statePath`, so tests and builds get their
sandbox (`src/lib/stateOwnership.ts`). A write is an ordinary settings write
that runs outside startup, so the MCP process may make it the way
`role_presets` already writes `role-presets.json`.

## 3. Counting running workers

One counter, `projectWorkerCounts()` in `src/lib/orchestrator/workerCount.ts`,
answers `{ byProject: Map<canonical project, number>, machine: number }`.
Every surface below reads it, so the header, the wake, the tool and the
Settings row cannot disagree. A worker is what the mandate says: each running
lane and each live spawned agent.

- **Lanes.** Pipelines that are open (no `closedAt`, `hiddenAt` or
  `dismissedAt`, the `isOpen` test of `seatTickSources.ts:866`) in state
  `provisioning` or `running`, grouped by
  `canonicalOrchestratorProject(pipeline.project)`. Drafts, `needs_review`,
  `needs_decision` and `paused` lanes run no agent and do not count.
- **Spawned agents.** Live hosts (the filter agent memory budgeting already
  applies: a structured host whose status is neither `dead` nor `unhosted`),
  each read by its conversation's spawn lineage edge (`lineageEdges`,
  `src/lib/agent/registry.ts:348`). One counts when the edge's parent is the
  project's active seat conversation and the conversation holds no pipeline
  membership; a stage agent is already counted as its lane. The seat itself
  and its parallel selves (deputies) never count.
- **Machine.** The sum over projects.
- **Cost.** Keyed registry reads bounded by the number of live hosts. It never
  takes a full registry snapshot and never pages through a seat's whole child
  history. Registry reads are under a performance incident right now (lane
  ce52f767, #2761/#2762): the build measures the counter on a registry the size
  of this machine's and keeps it under 50 ms. For the few seconds a launch
  receipt is still `starting`, it has no host and is not counted; for an
  advisory number that is acceptable.
- **Tests inject** the pipeline list and the registry reader, as
  `SeatTickSources` does.

## 4. Read path

1. **The seat-tick wake.** `seatTickWakeMessage` (`src/lib/monitor/report.ts`)
   takes `workers: { limit, source, machine, running }` and writes one line in
   the reserved tail, above the contract pointer, so the length bound never
   cuts it:

   - source machine: `Worker limit here: 8 (the machine default). It replaces any number your mandate or launch text names. Running here now: 7.`
   - source project: `Worker limit here: 10 (this project's own; machine default 8). It replaces any number your mandate or launch text names. Running here now: 7.`

   The gather (`gatherSeatTickInput`) reads `effectiveWorkerLimit(project)` and
   the counter once per check. Every scheduler-fired wake carries the line, so a
   change at 10:00 reaches an unrotated seat at its next wake. The "replaces"
   sentence is for seats delivered before this change, whose context still
   says "3 when they name none".
2. **`get_orchestrator`**, compact and full:
   `workerLimit: { value, source, machine, running }`, about 60 bytes. A seat
   whose tick is off, or that acts on an operator message between wakes,
   reads it here.
3. **`GET /api/orchestrator/seat/status`**, which the seat header already
   polls (`src/components/orchestrator/incumbent.ts:4`), gains
   `workers: { running, runningMachine, limit, source, machine }` for the
   header face and its popover (§5.1). The header needs no new request.
4. **`role_presets`** reads (§7).
5. **`GET /api/operator/worker-limit`** for the Settings row (§5.3). The
   header popover reads the seat status answer of item 3.
6. **The mandate (next version, v46 on today's main).** The worker line names
   no number:

   `- Keep no more workers running at once than the worker limit each wake and get_orchestrator state, in every mode: each running lane and each live spawned agent counts as one.`

   That is 3 bytes longer than v45's line. Bump `ORCHESTRATOR_PROMPT_VERSION`,
   re-pin the fingerprint in `prompt.test.ts` and update its `toContain` at
   line 867. Delivery replaces v45's exact line with this one, through the
   mechanism `SHIPPED_GREETING_OFFERS` uses, so a carried-forward or kept
   mandate stops saying 3 at its next delivery.
7. **The orchestrator scaffold.** The worker sentence leaves the scaffold.
   Seats get the rule from the mandate. An orchestrator launched without the
   mandate gets one sentence added to `ORCHESTRATOR_WITHOUT_MANDATE_RULES`
   (`src/lib/roles/defaults.ts:95`), which `roleSpawnPrompt` appends only when
   the brief carries no mandate. The seat's launch overhead shrinks by about
   115 bytes. That matters: `handoffDigest.test.ts` records a 24-byte rotation
   history margin today, and three open PRs that touch `prompt.ts` (#2641,
   #2744, #2758) spend bytes too. A stored scaffold override
   (`role-presets.json`) that still contains `{{maxWorkers}}` is rendered with
   the project's effective limit at launch, and the wake line governs after
   that. This machine has no such override.

Nothing enforces the cap in code, and this design adds no enforcement
(Deferred). "Anything else that counts or enforces worker slots" is the list
above.

## 5. UI

Decided by the operator on prototype review
`pr_b60c7b011154faf0c163a7b82444d91e` (2026-10-12 07:59Z, §12): the machine
default is a row in ⋯ → Settings, a project's own limit is changed by pressing
«воркери 7 / 10» in the seat header, and no UI change asks for a reason. No
variant was chosen; the orchestrator settled the face on the most compact form,
plain small text with a tiny dot for an own limit, following the operator's
standing preference for minimal status UI (a dot and a short popover, never a
wide text pill). Two existing surfaces carry everything, and no panel is added.

### 5.1 Seat header: «воркери 7 / 10», and the popover behind it

The seat header (`IncumbentHeader`, `src/components/orchestrator/IncumbentHeader.tsx`)
is where the operator already reads who holds the seat, its model, its account
and how full its context is (`ContextMeter`). It is mounted in the dock and
inline in the kanban seat's header (`OrchestratorPanel.tsx:573, 731`). One new
component, `WorkerLimitChip` in `src/components/orchestrator/`, goes on the
identity row right after `<ContextMeter>`, outside the right-hand controls
group, so it reads as status beside the context meter.

**Face.**

- Plain text, en «workers 7 / 10», uk «воркери 7 / 10», `text-caption` with
  `tabular-nums`, no border, background or bar. Tone `text-secondary` while
  running ≤ limit, `text-warning` above it.
- Own limit: a 4 px round dot (`bg-accent`, `aria-hidden`) right after the
  limit, at the cap height, like a superscript. With the machine default or the
  shipped default there is no dot. No «свій» / «own» word ever goes on the
  face.
- It is a `<button>` that looks like text: `h-6`, `px-1`, `rounded-control`,
  hover `text-accent`, the focus ring the row's other controls use. Its
  accessible name and `title` carry the source: «7 працюють · ліміт 10, свій
  ліміт проєкту» / «7 running · limit 10, this project's own», or «… ліміт 8 з
  глобальних» / «… limit 8 from the machine default».
- `shrink-0`; the identity row already wraps inside the `incumbent-host`
  container query (globals.css), so at the dock's 360 px floor the chip moves to
  the next line with the context meter and is never cut. The prototype measured
  the numbers-only face at 61–107 px.
- No data yet (the status poll has not answered, or answered without
  `workers`): the chip is not drawn, the way `ContextMeter` draws nothing
  without context.

**Popover** (`WorkerLimitPopover`, same file). A press toggles it. It reuses
the seat tick popover's mechanics unchanged (`SeatTickChip.tsx:91`): portalled
to the body, placed by `useAnchoredBox` (`src/components/feed/SpeakMenu.tsx:96`),
`useModalLayer` with `lockScroll: false` for Escape, the Tab trap and focus
return, close on a pointer outside and when the anchor scrolls away, and the
same `openFor === project` guard so a project switch closes it. Width 256 px
(`w-64 max-w-[calc(100vw-16px)]`). Content, top to bottom:

1. Title, `text-ui font-semibold`: «Ліміт воркерів» / «Worker limit».
2. One row: the number field and, beside it, the source in `text-label`:
   «свій ліміт» / «own limit», or «з глобальних» / «from the machine default».
   With no own limit the field shows the machine value as its placeholder and
   is empty.
3. `text-label text-muted`: «Працюють 7 · на машині 19» / «7 running · 19 on
   machine».
4. Only when an own limit is set: a text button «Скинути до глобального (8)» /
   «Reset to machine default (8)».
5. `text-label text-muted`: «Глобальний: ⋯ → Налаштування» / «Machine default:
   ⋯ → Settings», so the other level is one glance away.

Field and save: the relay settings' number input
(`ExternalRelaySection.tsx:413`, class `NUMBER`): `type="number"`,
`inputMode="numeric"`, `min=1`, `max=64`, `w-14`, autofocused on open. It
saves on blur and on Enter (Enter also closes). Typing a number sets the
project's own limit, also when it equals the machine value: an explicit choice
stays explicit and gets the dot. Clearing the field and leaving it resets, as
the Reset button does. A value outside 1…64 or not an integer is not sent: the
field returns to the stored value and line 3 shows «Від 1 до 64» / «From 1 to
64» in `text-warning` until the next edit. A failed save rolls back with «Не
збережено, спробуйте ще раз» / «Not saved, try again». After a save the face
takes the route's answer at once, and the next status poll confirms it.

**Phone.** The seat sheet's identity block (`MobileOrchestratorSheet.tsx`,
below the context row at line 1216) gets one row in the context row's anatomy:
the label «Воркери» / «Workers» in `text-label font-semibold text-muted`, then
«7 / 10» in `text-label tabular-nums text-secondary` with the same 4 px dot
for an own limit. The row is a `<button>` with `min-h-11` so it meets the
phone's 44 px target, and pressing it opens the same `WorkerLimitPopover`
anchored under it; `useAnchoredBox` and the `max-w` keep it inside a 390 px
viewport. No sub-sheet: the content is two controls, and the tick's
`MobileSeatTickSheet` route exists for a much larger body.

### 5.2 Machine default: one row on the Settings page

Header ⋯ → **Settings / Налаштування**, the existing page that holds the
machine's own settings. One new `HeaderItem`, `"workers"`, in both
`HEADER_LAYOUTS` (`src/components/headerMenu/headerMenuModel.ts`), after
`"mapping"`. The row edits in place, the way the language row does, so no
dialog or panel opens. It is three presses from a closed menu, like every
Settings entry.

- Anatomy of the memory and key rows (`TwoLines`): an icon the menu does not
  use yet (lucide `Layers`), the title en «Workers per project» / uk
  «Воркерів на проєкт», a muted second line, and the number field (`w-12`) at
  the right. The menu panel is 232 px wide (`ProjectRail.tsx:525`), and the
  prototype measured 126 px for the text column: a longer title or a second
  line with a «Зараз:» prefix was cut.
- Second line: «7 тут · 19 на машині» / «7 here · 19 on machine». On the
  overview (no project open): «19 на машині» / «19 on machine». When the open
  project has its own limit: «Тут свій ліміт: 10» / «Here: own limit 10», so
  the Settings page also shows that a project overrides the default.
- Field, bounds, save and failure lines as in §5.1; the write is the machine
  default.
- Phone: a `custom` entry of the phone Settings page drawn with
  `MobileSheetRow`'s classes (44 px, icon, two lines, field `w-20`).
  `MobileSheetRow` itself is a button and cannot hold an input.
- Height budget: `docs/design/header-menu.md` holds the desktop Settings page
  to 380 px and it measures 379 px today. The two-line row adds about 32 px
  (the prototype's page measured 410 px), so the page budget becomes 420 px; a
  700 px window still opens it whole. The design note, `SETTINGS_PX` in the
  kanban driver's block "the header's menu, built", and
  `headerMenuModel.test.ts` change with it. The phone sheet stays under its
  743 px.

### 5.3 Route

One route serves both levels, `src/app/api/operator/worker-limit/route.ts`:

- `GET ?project=` → `{ machine: { value, default, min, max, source,
  changedAt, changedBy }, project: { key, value | null, effective, source } |
  null, running: { here | null, machine } }`.
- `PUT { value }` sets the machine default (`via: "settings"`).
  `PUT { project, value }` sets that project's own limit, `value: null`
  clearing it (`via: "seat-header"`). Both go through `rejectCrossOrigin`,
  then `requireOperatorAuthority` (an agent capability is refused and pointed
  to `role_presets`), then `setMachineWorkerLimit` or `setProjectWorkerLimit`
  with `{ kind: "operator", via }` and a null reason. Answers as GET. 400 with
  the bounds for an invalid value.

The face reads `workers` from the seat status poll it already makes (§4 item
3); only a save calls this route. `GET /api/projects/settings` and
`project-settings.json` are not touched.

The operator's own UI changes record no typed reason, as the operator chose:
the history says it was the operator and where (`via`). Agents must give one
(§7).

## 6. Override semantics

- Effective limit = the project's own value, else the machine default, else 3.
- Setting a project's own limit, from the seat header popover or the tool,
  takes effect for that project only, even when it equals the machine value;
  the dot then marks the face until it is reset.
- Changing the machine default changes every project without an own value at
  their next wake. A project with an own value keeps it until someone resets
  it.
- Resetting a project returns it to the machine default and records `to:
  null`.
- No override is created automatically: no migration seeds any project, and
  this project's 30 becomes whatever the operator sets after the release (an
  own limit for Delegatus, or the machine default). Its seat memory note is
  then removed.
- The orchestrator role parameter `maxWorkers` is retired. It leaves
  `ROLE_DEFAULTS` (so the draft pane stops drawing its field), the i18n labels
  go, and the `spawn_agent` clamp entry leaves `MCP_BOUNDED_NUMERIC_ARGS`. So
  that old callers and stored pipeline stages keep working,
  `validateRoleParams` drops a `maxWorkers` key on the orchestrator role; an
  unknown key elsewhere is still refused. `spawn_agent` answers `ignored: {
  "roleParams.maxWorkers": "the project's worker limit applies (N, source);
  change it with role_presets workerLimit" }`, following the `clamped`
  precedent, so the caller learns its value had no effect.
- When the operator names a number for one project in chat, the seat sets that
  project's own limit through the tool and says so. When they name a number
  for everything, it sets the machine default.

## 7. Tool surface: `role_presets` gains `workerLimit`

Agents use the existing machine-wide settings tool. `role_presets` already
covers "how each role runs" for the whole install, already admits writes only
from the designated orchestrator seat (a deputy speaking as it) and the
operator's own session (`rolePresetsTool`, `src/lib/mcp/bindings.ts:4577`),
and orchestrators already read it. The cap used to be an orchestrator role
parameter, so this is where an agent will look for it. A new tool would add
another entry to every agent's tool list for two integers.

- **Schema** (`src/lib/mcp/server.ts`, `role_presets`):
  `workerLimit: z.object({ value: z.number().int().min(1).max(64).nullable(), project: z.string().trim().min(1).optional(), reason: z.string().trim().min(1).max(300) }).optional()`.
  Without `project` it sets the machine default (`null` restores 3); with
  `project` it sets that project's own limit (`null` clears it). `project`
  resolves through `resolveOrchestratorToolProject` like
  `seat_tick_settings`. Naming another project than the caller's own is
  allowed, recorded as such, and the answer says `scope: "other-project"`.
  `reason` is required: what the operator asked, or why the seat changed it.
- **Read.** Every `role_presets` read carries
  `workerLimit: { machine: { value, source, changedAt, changedBy }, here: { project, value | null, effective, source, running } | null, runningMachine, bounds: [1, 64] }`,
  `here` being the caller's project when it resolves. `detail: true` adds
  `projects` (every own limit) and `history` (the newest 20 entries).
- **Write.** Same refusal as `overrides` for any other caller:
  `role_presets_write_refused`. Out-of-range values are refused by the schema
  with the bounds named. `workerLimit` together with `overrides` in one call is
  refused (`worker_limit_with_overrides`), because the two live in different
  files and one call must not half-succeed. `expectedRevision` does not apply.
  The actor `{ kind, conversationId, project, via }` comes from
  `attributionOf`. The answer is `{ changed, scope: "machine" | "project" |
  "other-project", project, from, to, effective, running }`.
- Idempotent by `clientRequestId`, like every mutation of the server; the id
  is kept on the history entry.
- **Description.** Two sentences appended to the `role_presets` description:
  the machine default and per-project limits, and that running seats read them
  at their next wake. The mandate gets no tool detail: its byte budget is
  nearly spent, and details belong in tool descriptions.

## 8. Audit records

Every change from the Settings row, the seat header popover or the tool is one history
entry: `at`, `scope`, `project`, `from`, `to` (null meaning "inherits"), `by`
(`kind`, `conversationId`, `project`, `via`: `settings`, `seat-header` or
`tool`), `reason` (null only for the operator's own UI change),
`clientRequestId`. A write that changes nothing records nothing. Agents read
the record through `role_presets detail:true`. The UI shows the current values
and usage, and no history.

## 9. Tests

Run each by path through `scripts/gate-slot.sh bun test <file>`, with an
isolated `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR`, and
`LLV_VIEWER_CONTROL_URL` on a closed port.

1. `src/lib/operator/workerLimit.test.ts`:
   - Default: an absent file gives 3 with source `default` for every project.
     A malformed file or a value outside the bounds falls back with
     `unreadable`.
   - Machine set to 8: every project reads 8 with source `machine`, and the
     history holds `machine 3 → 8` with actor and reason.
   - Project override: project A set to 10 reads 10 with source `project`
     while B reads 8. Resetting A gives 8 and records `to: null`. The override
     is found under its moved key (alias through `canonicalProject`).
   - Bounds and no-ops: the same value again is `changed: false` with no
     entry. 0, 65 and 2.5 are refused and nothing is written.
   - History and locking: the history keeps the newest 500, and two writers
     under the lock both record a truthful `from`.
2. `src/lib/orchestrator/workerCount.test.ts`:
   - Lanes: running and provisioning lanes count; paused, draft, needs_review
     and dismissed lanes do not.
   - Agents: a live seat-spawned agent counts, a stage agent counts once (as
     its lane), and the seat, a deputy and a dead host do not.
   - Totals per project and for the machine.
3. `src/lib/monitor/report.test.ts`: both wake lines (machine source, project
   source) sit in the reserved tail and survive a wake cut by the length bound.
4. Seat tick gather or controller test: after `setMachineWorkerLimit(10)` the
   next wake of an unrotated seat says 10. After `setProjectWorkerLimit(p, 12)`
   it says 12 with the project source. This covers "a running seat picks up a
   change without a rotation".
5. `src/lib/orchestrator/prompt.test.ts`:
   - The new worker line and the new fingerprint, and the line holds no digit.
   - Delivery replaces v45's exact line.
   - The delivered-size test passes, and `handoffDigest.test.ts` keeps its
     margin.
6. `src/lib/roles/registry.test.ts`, `parameters.test.ts` and
   `src/lib/pipelines/roles.test.ts`:
   - The orchestrator scaffold carries no worker number.
   - A `maxWorkers` key is dropped and the launch proceeds.
   - A stored scaffold override with `{{maxWorkers}}` renders the effective
     limit.
   - An orchestrator without the mandate still gets the worker rule.
7. `src/lib/mcp/bindings.test.ts`:
   - Reads: a `role_presets` read carries both levels and the counts, and
     `get_orchestrator` carries `workerLimit` with its source.
   - Writes with audit: a seat sets the machine default to 12 with a reason,
     and the history holds it with the seat's conversation and project. A seat
     sets its own project to 5, sets another project (answer says
     `other-project`), and clears it.
   - Refusals: a non-seat caller, a missing reason, 0, 65, and `workerLimit`
     together with `overrides`.
   - Retired param: `spawn_agent` with `roleParams.maxWorkers` launches and
     answers `ignored`. This replaces today's clamp test at line 623.
8. Route tests, `src/app/api/operator/worker-limit/route.test.ts`:
   - GET defaults, with and without `?project=`.
   - An operator `PUT { value }` sets the machine default, recorded with
     `via: "settings"` and a null reason.
   - An operator `PUT { project, value }` sets the project's own limit, and
     `value: null` clears it, both recorded with `via: "seat-header"`.
   - An agent capability, a cross-origin PUT and an invalid value (0, 65, 2.5,
     a string) are refused, and nothing is written.
   - `GET /api/orchestrator/seat/status` carries `workers` with its source.
9. DOM tests:
   - `WorkerLimitChip` (`IncumbentHeader` host and the phone seat sheet row):
     the face in en and uk; no dot with the machine or shipped default and a
     dot with an own limit; the accessible name naming the source; the warning
     tone above the limit; nothing drawn without `workers`.
   - `WorkerLimitPopover`: opens on press and closes on Escape, on a pointer
     outside and on a project switch; shows «з глобальних» with the machine
     value as placeholder, then «свій ліміт» after a blur save; Reset clears
     it; clearing the field resets; an out-of-range value is restored with
     «Від 1 до 64»; a failed save rolls back.
   - `HeaderMenu.dom.test.tsx`: the Settings row in en and uk, its three
     second-line states (here and machine, overview, project override), a
     blur save, an out-of-range restore, a failed-save rollback.
   - `headerMenuModel.test.ts`: the new item on both surfaces in three presses.

`src/components/kanban/seatAgentWindow.dom.test.tsx:111` uses the old text as
a fixture title only and may stay.

## 10. Rendered evidence

All through existing drivers, with no new driver:

- **Settings row**: the kanban driver's block "the header's menu, built"
  (`src/components/kanban/kanbanBoard.browser.test.tsx:5857`). 1440×900 and
  390×844, en and uk, light and dark, with a project open and on the overview.
  The case records the page height against the new 420 px budget, measures
  each label as a Range against its box so a cut label is caught, and records
  the field's width.
- **Seat header face and popover**: the kanban seat's header is drawn by the
  same driver over `issue1695Evidence.fixture.tsx`; the phone seat sheet by the
  phone driver (`src/components/mobile/issue1671Evidence.browser.test.tsx`).
  Both at the same widths, languages and themes, with a project on the machine
  default, a project with its own limit (the dot) and a project over its limit
  (warning tone), each closed and with the popover open. The case measures the
  face and every popover label as a Range against its box, records the
  popover's rect against the viewport (inside 390 px with 8 px margins), and
  records the face's width at the dock's 360 px floor.
- Frames are written into the existing evidence records, and media follow the
  repository's evidence rules.

## 11. Build notes and fences

- Open PRs #2641, #2744 and #2758 change `src/lib/orchestrator/prompt.ts`
  (#2744 also `roles/defaults.ts`). Each bumps the mandate version and spends
  mandate bytes, so the build takes the next free version at merge time and
  re-measures `prompt.test.ts` and `handoffDigest.test.ts` after merging main.
  #2769 also touches `src/lib/mcp/server.ts` and `bindings.ts`.
- Update in the same PR: `docs/design/agent-prompt-contract.md` (the quoted
  scaffold and line, §3 (c1)) and `docs/design/header-menu.md` (budget and
  row).
- Production deploys are frozen by an incident. Nothing here needs a deploy to
  be verified.

## 12. Prototype review and the decision

The look was published as prototype review
`pr_b60c7b011154faf0c163a7b82444d91e` on this task: three variants, 24 frames
at 1440 and 390 px, en and uk, light and dark, drawn with the production
stylesheet over the real `IncumbentHeader` and `BridgeReportsRow`. Measured:
no label cut (Range against box), no horizontal overflow, Settings page
410 px, the face 61–107 px wide.

1. **Numbers.** «воркери 7 / 10»; the source only on hover.
2. **Numbers and source tag.** The same, plus a small «свій» / «own» tag.
3. **Bar like the context meter.** People icon, «7/10» and a 32 px bar.

The operator answered the three questions on 2026-10-12 at 07:59Z and chose no
variant:

- Machine default: a row in ⋯ → Settings with a number field (the
  recommendation).
- A project's own limit: press «воркери 7 / 10» in the seat header and change
  it there, in a small popover with the number, «Скинути до глобального» and
  the source. This was option b; the recommended project ⋯ → Orchestrator row
  is not built.
- No reason prompt in the UI: the record says the operator changed it and
  where (the recommendation).

With no variant chosen, the orchestrator decided the face: the most compact
form, variant 1's plain numbers, with a tiny dot for an own limit in place of
variant 2's tag, and the source words only in the popover. §5 is written to
these answers and is the visual contract for the build.

## Deferred — not currently justified

- **Enforcement.** Refusing `create_pipeline` starts or `spawn_agent` launches
  past the limit. Today the cap is the seat's discipline, and the morning's 22
  lanes show it can be exceeded. Admission would interact with the CPU
  admission queue (lane 022c8be9) and with pipelines the operator starts by
  hand. That is a separate decision.
- **Pushing a change to running seats at once**, as a message to every seat.
  The next wake and `get_orchestrator` already carry it.
- **A worker-limit row in project ⋯ → Orchestrator.** The operator chose the
  seat header popover instead (§12); one place per level is enough.
- **A bar or icon on the face** (variant 3) and **a «свій» word tag**
  (variant 2): the dot and the popover carry the source.
- **A reason field in the UI**, and **history in the UI**.
- **Raising the shipped default above 3** for fresh installs.
