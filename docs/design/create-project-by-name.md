# Create a project by name alone

Status: build brief, 2026-11-01, read-only design stage. Every code claim was
checked against `main` at `c97325311` (the worktree's starting commit). Lane:
backend, then frontend, then review, then visual critic.

## 0. Originating requirement

From the operator on 2026-11-01, about 09:50 UTC, in the seat chat, in Russian.
Public files here carry no quotes from private conversations, so this is an
English paraphrase of the pinned task:

> Creating projects is very inconvenient right now. I want to type any name,
> have the project bound to some folder automatically, and have no trouble
> with it. Nobody should have to type a path.

The operator attached a screenshot. It shows a team member stuck on the create
form: the name is filled in, the error line says «Оберіть теку», and the
picker reads «директорію не вибрано», «відомих директорій ще немає — впиши
шлях», «0 з 0 директорій».

What this settles: the name is the only input, the server chooses and creates
the folder, and a team member can do this as well as the owner. Everything
below is checked against that.

## 1. Why the member was stuck (verified)

Typing a path would not have helped the member either:

- The gate sends every non-owner member to `workspaceRouteDecision`
  (`src/lib/team/gate.ts:189-202`). Both create-form routes are marked
  `"owner"` (`src/lib/team/workspaceRoutes.ts:115`, `:118`), so for a member
  `POST /api/projects/create` and `GET /api/projects/directories` both answer
  `403 workspace_forbidden`.
- The form loads suggestions when it mounts (`src/components/ProjectRail.tsx:848-862`)
  and silently drops a failed answer. That is where "0 of 0" came from. Submit
  then refuses an empty root on the client (`ProjectRail.tsx:900-905`,
  `askForADirectory`).
- The rail still offers the create button to members, because `Viewer.tsx:1773`
  and `:1837` pass `createProject` unconditionally.

The phone has a second, separate form with the same problem:
`CreateProjectRows` (`src/components/mobile/MobileProjectSheet.tsx:281-324`)
requires a typed root and shows the server's English `message` as its error.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Default parent for the owner:** `$HOME/Projects`. If that does not exist and `$HOME/projects` does, use `$HOME/projects`. If neither exists, create `$HOME/Projects` on first use. `$HOME` is `homeDirectory()` (`src/lib/platformHome.ts:20`), which is `USERPROFILE` on Windows. There is no new setting. | No configured projects folder exists anywhere in the code (searched for `projectsDir`/`projectsRoot`/`Projects`). `homeDirectory()` is already the fallback root for suggestions and creation (`src/lib/projects/suggestionRoots.ts:35-37`, `:57`). Docker mounts `$HOME:$HOME` (`docs/docker.md:489`), so the same path works in the image. Deriving the parent from the busiest anchor would be unpredictable: on a machine whose projects are checkouts under a hidden tools folder, it would pick that hidden folder. |
| D2 | **Default parent for a team member:** the same folder as the owner's. Each project goes into a workspace (D6). | A member has no home of their own on this machine. Agents run as the installation's OS user (`docs/design/workspaces.md` §2, D3: "below the OS, a member equals the operator"). Isolation is by project key: `workspaceScope` (`src/lib/team/workspaceAccess.ts:10-49`) decides what a member sees. A folder per workspace would add rename handling and nested-repository hazards and isolate nothing more. It stays deferred (§9). |
| D3 | **Allowed roots:** `suggestionRoots()` also includes the default parent, placed just before home and kept even past the cap. The anchors take `SUGGESTION_ROOT_LIMIT - 2` slots. | Creation and suggestion share one list (`suggestionRoots.ts:12-16`, issue #1223). `boundedTarget` follows symlinks (`src/lib/projects/directorySuggestions.ts:109-124`), so a `$HOME/Projects` that links outside home would fail the bound. With the parent in the list, its resolved form joins `suggestionBound().resolved` (`:87-92`). That is how acceptance 4 ("the auto-chosen folder always passes") holds. When the parent is already an anchor, deduplication means no slot is lost. |
| D4 | **Members get only the default flow.** "Use an existing folder…" and `/api/projects/directories` stay owner-only. A member request that carries `root`, even a blank one, is refused with `403 workspace_forbidden`, and nothing is created. | The root of a manual project becomes an `/api/artifact` read root (`src/lib/artifact/localFile.ts:73`). A member who could bind an existing folder such as `$HOME/.config` could read files through it. The test at `src/app/api/projects/directorySuggestionRoutes.test.ts:157` guards this same widening. Directory listings of the owner's home would also cross workspace views. A fresh empty folder widens nothing. |
| D5 | **Who may create:** the owner, and any active member whose role in the target workspace is `member` or `manager`. | A new project is empty and moves nobody's work. `placeProject`'s manager-only rule (`src/lib/team/workspaces.ts:255-261`) protects existing projects from being moved between workspaces. That is a different act. |
| D6 | **Target workspace:** the client sends `workspaceId`. It is the rail's current choice when that choice is a workspace. When the choice is All: an owner sends nothing, so the project is Unassigned as today. A member with exactly one workspace sends that one. A member with several sees a native `<select>` labelled Workspace in the form, defaulting to the first in rail order. | A member cannot see a project in no workspace (Unassigned is owner-only, workspaces.md D5), so a member's project must be placed. Today the default choice is All (`src/components/team/workspaceFilter.ts:26-29`). Placing the owner's project into the chosen workspace keeps the new row in the list they are looking at. |
| D7 | **Placement** uses a new `placeCreatedProject(store, actor, project, workspaceId)` in `src/lib/team/workspaces.ts`. In one store transaction it checks that the actor is active, that the actor is the owner or has a `member`/`manager` role in the workspace, that the workspace exists, and that the project has no placement row. Then it calls `writePlacement`. | This cannot move an existing project: it only accepts a project with no placement, and the route passes only the key it just created. `placeProject` stays unchanged. |
| D8 | **Folder name:** a slug, defined in §3. A pure module, `src/lib/projects/folderName.ts`, with no Node imports so the form can preview it. | The preview in the typing state needs the same function the server uses. |
| D9 | **A folder with the derived name already exists** (a directory, a file or a symlink, which exclusive `mkdir` answers with `EEXIST` without following it): try the next suffix, `-2` up to `-99`. An existing folder is never reused, even an empty one. | Reuse would need an emptiness check, which races with the bind. It would also let a member bind the owner's planned folder. Suffixing is one rule. Exclusive `mkdir` (D10) makes it safe under concurrency. |
| D10 | **Create sequence:** check the parent with `boundedTarget(parent, roots)`. Then guard the parent with `repositoryRootForPath(parent)`, before anything exists, so a refusal leaves nothing behind. Then `mkdir(parent, { recursive: true })`. Then, for each candidate: skip a key an alias still holds for a deleted folder. Then non-recursive `mkdir(candidate)`. `EEXIST` moves to the next suffix; any other error is `MKDIR_FAILED`. Then `createManualProject(name, candidate, existing, { allowedRoots: roots })`, which measures the candidate against the bound again. If that fails, `rmdir` the candidate this request created (non-recursive); `DUPLICATE_PROJECT`, which also covers a key the catalog or a placement still holds, moves to the next suffix, and any other failure is returned. | Exclusive `mkdir` is the claim, so two creates of the same name get `pr-gram` and `pr-gram-2`. Removing only the folder this request created means a failed store write leaves nothing behind, and nothing the request did not create is ever deleted. A key left by a deleted folder would otherwise inherit that project's placement or join its alias target, and answer a member with a refusal about a project outside their scope. |
| D11 | **Parent inside a Git checkout:** if `repositoryRootForPath(parent)` is not null, refuse with `PARENT_IN_REPOSITORY` and create nothing. | Otherwise `createManualProject` would mint the enclosing repository's identity (`src/lib/projects/curation.ts:138-140`). The new folder would silently join that repository, or come back as `DUPLICATE_PROJECT` for every name. This is rare, so it gets a plain error and no machinery. |
| D12 | **A project with the same name exists:** refuse with `409 DUPLICATE_NAME`, carrying `{ project, displayName, root }`. The form says so and offers «Open it». Nothing is created. There is no "create anyway". | Two rail rows with the same name cannot be told apart. The name check compares a key of each name: `cleanWorkspaceName`, then `workspaceNameKey` (`src/lib/team/contract.ts:359-371`: NFKC, invisible characters stripped, case folded). It runs against the labels the caller can see: `workspaceCatalog().projects` (`src/lib/team/workspaces.ts:276`), with presentation renames applied once #3493 lands (§8), restricted for a member to `scope.projectFilter.allowed`. A member gets no report about a project outside their scope. Their folder simply takes a suffix if needed, so nothing leaks across workspaces. |
| D13 | **No `git init`.** The folder is a plain directory with a `dir-` key. | Pipelines already offer to initialize a repository when preflight answers `not_git` (`src/lib/pipelines/initializeRepository.ts:247`). Initializing here would also change the key path (`dir-` to `repo-<local>`, `AGENTS.md` "The same folder can change key"). |

## 3. Slug rules (`folderName(name)`)

1. Normalize with NFKC and lowercase.
2. Transliterate Cyrillic with the Ukrainian national table (KMU 2010): а a,
   б b, в v, г h, ґ g, д d, е e, є ie, ж zh, з z, и y, і i, ї i, й i, к k, л l,
   м m, н n, о o, п p, р r, с s, т t, у u, ф f, х kh, ц ts, ч ch, ш sh,
   щ shch, ю iu, я ia. At the start of a word (preceded by the start of the
   string or a non-letter) є→ye, ї→yi, й→y, ю→yu, я→ya. The letter ь and
   apostrophes (', ’, ʼ) are dropped. For Russian-only letters: ё→yo, ы→y,
   э→e, ъ dropped. The `зг→zgh` rule is left out: it only matters for display.
3. Decompose with NFKD and remove `\p{M}`, so é→e and ü→u.
4. Replace every run of characters outside `[a-z0-9]` with one `-`, then trim
   `-` from both ends. Only `a-z`, `0-9` and `-` remain. That means no dot
   files, no separators, no `..`, and names that are safe on case-insensitive
   macOS and Windows.
5. Keep at most 48 characters. If the name is longer, cut at the last `-`
   after position 24 if there is one, otherwise at 48, then trim `-`.
6. If the result is empty (emoji, CJK, symbols only), use `project`.
7. Reserved results get the suffix `-project`: `con prn aux nul com1–9
   lpt1–9` (Windows device names) and `worktrees`. A folder named `worktrees`
   under the parent would make `worktreeFromNested` group later sessions in
   its subfolders under the parent folder (`AGENTS.md`, recognizer #3).
8. Collision suffixes (D9) are added after step 5, so the longest name is 51
   characters.

Examples for the tests: `PR GRAM` → `pr-gram`; `Мій проєкт` → `mii-proiekt`;
`Щоденник` → `shchodennyk`; `Ярослав` → `yaroslav`; `Café déjà vu!` →
`cafe-deja-vu`; `  ../../etc  ` → `etc`; `项目` → `project`; `CON` →
`con-project`; `worktrees` → `worktrees-project`; an 80-character name → at
most 48.

The display name stays exactly what was typed, trimmed (1–80 characters, as
today in `curation.ts:101-104`).

## 4. API: `POST /api/projects/create`

Body: `{ name, root?, createRoot?, workspaceId? }`.

- **`root` absent, null or blank: the default flow (new).** The server derives
  the folder (§3, D10) and binds it. `createRoot` is ignored.
- **`root` present: the existing-folder flow.** Unchanged for the owner,
  including `RELATIVE_ROOT`, `OUTSIDE_ROOTS`, `MISSING_DIRECTORY` with
  `createRoot` opt-in, and the bound from `suggestionRoots()`. A member gets
  403 (D4).
- **`workspaceId`:** when given, the server checks it before anything is
  created (D5, D6). A member must give it. A missing or forbidden value is
  `403 workspace_forbidden` and creates nothing. After creation the project
  is placed with `placeCreatedProject` (D7). If placement loses a race (the
  role was revoked in between), the answer is `403 workspace_forbidden`. The
  project then stays Unassigned and visible to the owner. Nothing is rolled
  back, and this is documented in the route comment.
- **Gate:** `"/api/projects/create"` changes from `"owner"` to `"team"` in
  `workspaceRoutes.ts:115`. The gate passes `team` routes to the handler
  (`gate.ts:200`), and the handler makes the member checks itself. It reads
  the member with `requestWorkspaceScope` (`src/lib/team/workspaceRoute.ts:18`):
  `null` (solo, verified MCP) or `scope.owner` means owner rules; a scope
  without `memberId` answers 401 `member_required`; otherwise member rules.
  `requireOperatorAuthority` and the post-body recheck (`create/route.ts:28-55`)
  stay as they are. Agents remain refused. `/api/projects/directories` stays
  `"owner"`.
- **Success:** `200 { ok, project, displayName, root, createdAt, workspaceId }`.
  The `root` is the folder that was actually created, including any suffix.
- **New refusals:** `409 DUPLICATE_NAME { project, displayName, root }`;
  `409 NO_FREE_FOLDER` (suffixes up to `-99` all taken);
  `409 PARENT_IN_REPOSITORY { parent }`. Existing ones are kept:
  `MKDIR_FAILED` 500, `STORE_ERROR` 500, `INVALID_NAME` 400,
  `INVALID_REQUEST` 400 (now: the name is missing or oversized, or the root
  is oversized or not a string).
- Server code lives in a new `src/lib/projects/createByName.ts`:
  `createProjectByName(name, { parent, allowedRoots, existing, visible, resolve })`
  returns the same result union as `createManualProject` plus the new codes.
  `visible` is the list of `{ project, displayName, root }` the caller may
  see; `root` is null for a project with no known folder. A store failure under
  a peer's write lock answers `STORE_ERROR`, because the store's writes do not
  wait. `defaultProjectsParent()` lives in `suggestionRoots.ts`, next to
  `homeRoot()`.

Client: `createProject(name, root: string | null, options?: { createRoot?, workspaceId? })`
in `src/hooks/useProjectCuration.ts:97`. When `root` is null the body omits
`root`. `CreateProjectOutcome` failures also carry `project`, `displayName`
and `root` when the server sent them. All three call sites
(`Viewer.tsx:1773`, `:1837`, `:2045`) keep passing `createProject`.

## 5. Form layout and states

Both forms change, with the same behaviour. The desktop rail form is
`CreateProjectForm` (`ProjectRail.tsx:804-1007`, about 228 px wide inside the
248 px rail), and the setup guide reuses it (`src/components/onboarding/ProjectStep.tsx:41`).
The phone sheet form is `CreateProjectRows` (`MobileProjectSheet.tsx:281-324`,
full sheet width at 390 px, 16 px fields, brand button). Both forms use one
error-to-copy function, `createErrorText(t, outcome)`, exported from
`ProjectRail.tsx` and replacing `CREATE_ERROR_KEYS`. The phone stops showing
the server's English `message`.

Top to bottom, each line present only in the states that name it:

```
desktop rail (≈228 px)                 phone sheet (390 px)
┌────────────────────────────┐         Name
│ Project name               │         ┌──────────────────────────────┐
└────────────────────────────┘         │ PR GRAM                      │
 New folder: pr-gram                   └──────────────────────────────┘
 [Workspace ▾]   (member, All, ≥2)     New folder: pr-gram
 error / collision line                [Workspace ▾]  (member, All, ≥2)
 [ Create ]  Cancel                    error / collision line
 Use an existing folder…  (owner)      [  Create  ]   (brand, full width)
                                       Use an existing folder…  (owner)
```

| State | Defining element | Desktop | 390 px phone |
|---|---|---|---|
| default | the empty name field with focus, and the Create button | Name field, Create and Cancel, then the text button «Use an existing folder…» (owner only). No picker is drawn and no `/api/projects/directories` request is made. | Name field, full-width Create, then «Use an existing folder…» (owner only). |
| typing | the line `New folder: <slug>` under the field, with the slug in monospace, from `folderName` | The line wraps, so the slug is always whole. | The same. |
| creating | Create shows a spinner and «Creating…» | The button is disabled and the name field is read-only. Waiting on the server is deliberate: the folder name, the key and the collision answer are computed by the server, so an optimistic result cannot be shown here. | The same, using the phone's existing `Loader2`, and the button reads «Creating…» as on the rail. |
| created | the new row selected in the rail, with the typed name | The form closes and `onCreated(project, { name, root })` selects the project, as today. The guide chooses it, and its row shows the folder (`ProjectStep.tsx:80`). | The sheet closes and the project opens, as today. |
| error | one line in danger colour above the buttons | Copy from `createErrorText`. On the default flow no copy mentions typing a path. | The same line, `role="alert"`. |
| collision | the line «A project named «X» already exists» and the filled button «Open it» | «Open it» is the one filled control and stands where Create stood, with Cancel beside it. Create is not drawn and no folder line is shown while the name is taken, and Enter opens the project. «Open it» calls `onCreated(existing.project, { name: existing.displayName, root: existing.root })`, so it lands where a successful create would. The name field stays editable. Editing the name clears the line and brings Create back. | The same; «Open it» is a 44 px brand button. |

Opening «Use an existing folder…» shows today's `DirectoryPicker` and the
mkdir offer. Suggestions are fetched only once the section is open. The text
button becomes «Back to a new folder», which closes the section and clears
the chosen root. An open section with nothing chosen still creates by name, so
Create never refuses for lack of a folder (acceptance 1 and 3), and the line
under the name says so: «Leave it empty to create pr-gram». The picker's empty
value reads «Choose a folder…» on the rail and on the phone alike. A line that promises a new folder is hidden while a refusal or a
taken name says there will be none, and once a folder is chosen.

In the setup guide the footer's Continue is the form's main action while a name
is typed: it creates the project (or opens the project that carries the name)
and moves on; a refused create keeps the guide on the step. Create then stays a
border, so one control is filled. When the name is taken, «Open it» is filled
and Continue steps back to a border. The member's workspace choice is drawn in
the same ink as the name. Picking a
folder still names the project when the name has not been edited
(`ProjectRail.tsx:864-871`). On the phone the section shows the same picker, with the same suggestions
(`useDirectorySuggestions`), under the same plain label.

Strings to add, in en and uk (uk shown):

- `rail.newFolderPreview` «Нова тека: {slug}» / "New folder: {slug}"
- `rail.useExistingFolder` «Вибрати наявну теку…» / "Use an existing folder…"
- `rail.useNewFolder` «Повернутися до нової теки» / "Back to a new folder"
- `rail.newFolderOptional` «Залиште порожнім, щоб створити {slug}» / "Leave it empty to create {slug}"
- `rail.workspaceLabel` «Робочий простір» / "Workspace"
- `rail.duplicateName` «Проєкт «{name}» уже існує» / "A project named «{name}» already exists"
- `rail.openExisting` «Відкрити» / "Open it"
- `rail.noFreeFolder` «Усі назви тек для «{slug}» зайняті — змініть назву» / "Every folder name for «{slug}» is taken — change the name"
- `rail.parentInRepository` (owner) «Тека проєктів лежить у Git-репозиторії — виберіть наявну теку» / "The projects folder is inside a Git repository — choose an existing folder"
- `rail.parentInRepositoryMember` «Тека проєктів недоступна — попросіть власника встановлення» / "The projects folder is unavailable — ask the installation owner"
- `rail.workspaceForbidden` «Немає доступу до цього робочого простору» / "You no longer have access to this workspace"

The phone's `mobile2.projects.createFailed` is kept for the generic failure;
its typed «Root directory» field and placeholder are gone, replaced by the
picker. The picker's
empty value `dirPicker.empty` reads «Choose a folder…» / «Оберіть теку…»; no
other `dirPicker.*` copy changes, and all of it appears only inside the opened
secondary section.

## 6. What not to touch

- The row menu from PR #3493 (lane 08315f24). That PR is open and changes
  `ProjectRail.tsx`, `MobileProjectSheet.tsx`, both i18n files, `Viewer.tsx`,
  the kanban driver and its fixture. Its diff leaves `CreateProjectForm` and
  `CreateProjectRows` alone apart from the imports. Merge current
  `origin/main` before editing, and rebase onto it again if #3493 lands
  mid-lane. Keep its menu, `actions` and `projectCwds` props exactly as they
  land.
- `createManualProject`'s existing-folder behaviour, `boundedTarget`,
  `suggestDirectories` and `DirectoryPicker`. The only change is that one
  added root (D3).
- `placeProject` and the `/api/team/workspace-projects` route, and the
  `"owner"` decision of `/api/projects/directories`.
- The worktree → project grouping recognizers (`src/lib/scanner/describe.ts`).
  A fresh `dir-` folder needs nothing new there.
- `workspaceRoutes.ts` is also touched by open PRs #3508, #3415, #3265 and
  #3263, each adding routes. This change edits one existing line, so a
  conflict is mechanical.

## 7. Tests

The new server cases must be red on `main` (state why for each case in its
comment). Run them by explicit path through `scripts/gate-slot.sh` with an
isolated HOME, XDG_CONFIG_HOME, TMPDIR and `LLV_STATE_DIR` (AGENTS.md).

Server:

1. `src/lib/projects/folderName.test.ts` (new): every example in §3, plus
   initial and medial є/ї/й/ю/я, apostrophes, and the length cut at a
   hyphen.
2. `src/lib/projects/createByName.test.ts` (new), in a temp HOME:
   - the folder is created under `$HOME/Projects`, and `$HOME/Projects` is
     created when absent;
   - an existing `$HOME/projects` is used when `Projects` is absent;
   - an existing directory, file or symlink with the slug gives `-2`, and
     the symlink is not followed;
   - `-2` through `-99` all taken gives `NO_FREE_FOLDER` and no new folder;
   - the same name with different case, NFKC form or spacing gives
     `DUPLICATE_NAME` with the existing key, and no folder is created;
   - a name visible only outside a member's `visible` list creates a new
     project;
   - a parent inside a Git checkout gives `PARENT_IN_REPOSITORY`, and
     nothing is created;
   - a parent that symlinks outside `$HOME` passes the bound and the folder
     lands at the link's target;
   - a store failure (an injected `patchRows` throw) removes only the folder
     that request created and leaves an existing sibling untouched;
   - two concurrent calls with one name produce `pr-gram` and `pr-gram-2`.
3. `src/lib/projects/suggestionRoots.test.ts`: the default parent is in
   `suggestionRoots()` past the anchor cap, and the list stays at most
   `SUGGESTION_ROOT_LIMIT`.
4. `src/app/api/projects/directorySuggestionRoutes.test.ts`: `POST {name}`
   returns 200 with `root` equal to `$HOME/Projects/<slug>`, and the folder
   exists. All existing root-path cases stay green and unchanged.
5. `src/app/api/team/workspaces.routes.test.ts` (member fixtures exist there):
   - a member with role `member` in W creates by name; the answer is 200, the
     project is placed in W, and `workspaceScope(...).canAct(project)` is
     true;
   - a member sending `root` gets 403 and no folder or manual row is created;
   - a member with a `workspaceId` they do not belong to, or none, gets 403
     and nothing is created;
   - the owner with `workspaceId` gets the project placed there; the owner
     without one gets an Unassigned project;
   - `placeCreatedProject` refuses a project that already has a placement.
6. `src/lib/team/team.test.ts` (gate): a member session's
   `POST /api/projects/create` passes `teamGate`, while
   `GET /api/projects/directories` still answers 403. The route table test
   (`src/lib/team/workspaceRoutes.test.ts`) keeps passing unchanged.

Component:

7. `src/components/ProjectRail.dom.test.tsx`:
   - with only a name typed, Create calls `onCreate(name, null, …)`, makes no
     `/api/projects/directories` request, and selects the returned project;
   - the typing preview shows `pr-gram` for `PR GRAM`;
   - `DUPLICATE_NAME` shows the line, and «Open it» selects the existing key;
   - in uk, no error text on the default flow contains «шлях»/"path";
   - a member view (set through `setTeamViewForTests` with `me.role: "member"`)
     draws no «Use an existing folder…».
   The existing picker cases (`:363-640`) first open «Use an existing
   folder…». The case at `:519` ("a relative fragment is never committed")
   now expects the request with `root: null` in place of "Choose a
   directory".
8. `src/components/mobile/MobileProjectSheet.workspaces.dom.test.tsx`: the
   phone form submits by name alone and shows localized copy for a refusal.
9. `src/hooks/useProjectCuration` request shape: `root: null` sends
   `{ name }`, and `workspaceId` is forwarded. Cover this inside test 7
   through the real hook and its real `fetch` call, never a hand-written
   stand-in for the hook.

Rendered evidence: use the existing kanban driver and add no new one. Add one
`describe("create a project by name alone")` block to
`src/components/kanban/kanbanBoard.browser.test.tsx` over
`issue1695Evidence.fixture.tsx`. The fixture's `window.fetch` stub
(`issue1695Evidence.fixture.tsx:4105`) answers `/api/projects/create` by a
`createstate=ok|collision|error|slow` query parameter, plus `teamrole=member`
for the member variant. Frames go to an ignored `.artifacts/` directory. Cover
every state in §5 at 1440×900, 1000×700 (the width between) and 390×844
(mobile), in en and uk, light and dark. Follow the pattern of the "retained
worktree drilldown" block (`kanbanBoard.browser.test.tsx:85-96`). The rail's
existing `create` state (`:30078`) stays. Run it with `LLV_KANBAN_BROWSER_TEST=1`,
`CHROME_BIN` and a short Chrome TMPDIR, through `gate-slot.sh`.

## 8. Order and interaction with #3493

The backend lands first (D1–D13, tests 1–6). It changes no UI, so it conflicts
with nothing in #3493. The frontend comes after `origin/main` is merged in.
If #3493 has landed by then, `presentationName` exists, and D12's labels must
be the presented names: apply `presentationName(projectPresentationSnapshot()[project], displayName, root)`
over `workspaceCatalog()`, the same label the rail draws. If it has not
landed, use `workspaceCatalog().projects[].displayName` and leave a one-line
comment naming #3493.

## 9. Deferred — not currently justified

- **A setting for the projects folder** (Settings UI or `LLV_PROJECTS_DIR`).
  The requirement asks for no path at all, and the conventional folder covers
  every installation seen so far, Docker included. Add one when an
  installation reports `$HOME/Projects` as wrong.
- **A folder per workspace** (`$HOME/Projects/<workspace>/<project>`). It
  isolates nothing more than D2, because agents share one OS user. It would
  need workspace rename handling and a guard against nesting into an owner
  project of the same name.
- **Reusing an empty existing folder.** Rejected in D9.
- **`git init` on create.** Pipelines already offer it (D13).
- **"Create anyway" on a name collision.** Two identical rows help nobody.
- **Showing the created folder's path in the rail after creation.** The guide
  already shows it, and the #3493 row menu carries `projectCwds`. Add it if
  people ask where their folder went.
- **An existing-folder option for members.** It is refused by D4 for artifact
  root safety. It needs a per-workspace bound first.
