# Pipelines in an ordinary folder on local Git

Design and G0, 2026-11-11. G0 implements the three starts in §8.2 and records
the office-folder acceptance clauses as expected failures. G1 to G6 remain
deferred. Every `file:line`
was read on main at `803f12c1` (2026-11-10 21:59 UTC). Where an earlier reading
of the same code gave another line, the code at `803f12c1` is used and the
difference is noted in one line. Numbers carried over from earlier
measurements say when they were taken and on which data set.

Short file names: `engine.ts`, `engine.fixture.ts`, `engine.creation.test.ts`,
`git.ts`, `git.test.ts`, `prompts.ts`, `preflight.ts`, `initializeRepository.ts`,
`repositoryInitialization.test.ts`, `fromConversation.ts`,
`fromConversation.test.ts` and `laneChanges.ts` are under `src/lib/pipelines/`;
`autoMerge.ts` is `src/lib/forge/autoMerge.ts`; `http.ts` is
`src/lib/laneReview/http.ts`; `diskPressure.ts` is
`src/lib/state/diskPressure.ts`. A bare `:N` continues the file named last in
the same cell or sentence.

## 0. Requirement

Requirement recorded on 2026-11-10.

- A person can start a pipeline in any folder with as little setup as
  possible: open the project, give it an orchestrator, and the pipeline runs.
- No GitHub, no sign-in and no pull request.
- The pipeline still works like any other: each stage hands its work to the
  next, with review and fix rounds.
- Git may stay underneath for one purpose: a person can see what changed and
  go back.

The program starts with local Git workflows that can run without a forge.

**Outcome of the program** (slices G0 to G6, one lane each). A person starts a
pipeline in an ordinary folder of documents with no GitHub, no sign-in and no
pull request. The product keeps a local Git repository for that folder itself,
so that what changed is visible, a reviewed result lands back in the folder,
and a result can be undone. The person never types a Git command.

The requirement asks for this build. What it does not ask for is kept in §11.

## 1. What a person does and sees

### 1.1 Today

Five starts, as they behave at `803f12c1` (§5.5 lists the probe):

1. **A small plain folder of code.** The picker's check writes nothing.
   Creating the pipeline makes a local repository on `main` with one baseline
   commit authored by Delegatus. The lane runs in a sibling checkout, its
   stages commit there, the reviews read those commits, the lane completes and
   its task finishes (the merge setting is off by default). The result stays
   on the lane branch in the sibling
   directory `<folder>-pipeline-<id>`. The folder itself never changes.
   "Review changes" on the card lists the first 200 changed files.
2. **An office folder**: 200 documents with ordinary names, a 3 MiB drawing,
   an 80 MiB archive, a folder named `out`, a file named
   `secret-handling.pdf`. The picker refuses it: "project exceeds the initial
   commit path-list bound". A smaller office folder is admitted, but the
   drawing, `out` and the PDF are left out of the repository, so no stage ever
   sees them.
3. **A draft from a conversation** that ran in a plain folder: refused,
   "conversation requires an existing Git working copy".
4. **A repository with no remote whose branch is `master`**, created with no
   base branch named: accepted, then the lane parks while it prepares with
   "resolving pipeline base refs/heads/main: fatal: Needed a single revision".
5. **A repository with no commit**: the picker says it is ready, creation
   accepts it, and the lane parks with the same message. Nothing tells the
   person what to do.

### 1.2 After the program

1. The person picks the folder. A plan shows how many files and bytes will be
   kept, what is left out and why, and how much disk the folder needs. One
   switch reads "Delegatus keeps this folder's history".
2. The pipeline runs. Stages work in their own checkout, hand work to one
   another, and review and fix as today.
3. The card says the result is ready and offers "Apply to the folder". Where
   the project lands results automatically, it is applied by itself.
4. The changed files appear in the folder. Files the person changed in the
   meantime stay as the person left them. Where both changed the same
   document, the person's version stays and the result lands beside it under a
   second name, and the card lists it.
5. "What changed" lists every changed file, page by page, and opens both
   versions of a document.
6. "Undo this result" puts the folder back as it was before that result.

The surfaces say "versions", "what changed" and "undo"; they show no Git word.

## 2. Earlier work this design builds on

Searches of earlier conversations and of project memory found no other design
for documents in a folder kept by the product. What exists is below; each item
was read again at `803f12c1`.

| Record | What it settled | Used here |
| --- | --- | --- |
| #2962, `docs/verification/pipeline-repository-initialization.md`, `docs/pipelines.md:11-35` | A plain folder is initialised on `main` with a safe baseline at creation; the picker's check is read-only; bounds, omissions and refusals; a local lane completes on its branch | §3 describes it; G1 extends it |
| `docs/design/git-first-forge-optional.md` (#3376) | Landing is a Git merge; a project with no remote lands into its local base, "applied" or "prepared"; completion from ancestry; GitHub is an adapter | §6.4, G3 and G4 take it unchanged |
| The answers to that design's questions, given on 2026-10-26 | Land with a merge commit; fast-forward a clean checkout, otherwise write a separate ref and say so on the card; the Git landing is off by default, per project | Binding. The design file still reads "needs the operator's answers"; the answers are recorded outside it (§10) |
| `docs/design/start-pipeline-from-conversation/implementation.md:34`, `:173` | The draft-from-conversation action refuses a folder without a repository and never initialises one | G0 changes this one row (§8.2) |
| `docs/design/create-project-by-name.md:62` | Creating a project makes no repository; pipelines initialise one when needed | Unchanged |
| #2282, `src/lib/pipelines/git.ts:467` | A lane checkout is brought forward with `git merge --ff-only --no-overwrite-ignore` | The apply step of §6.4 uses the same command |
| #1799, `src/lib/pipelines/engine.ts:15613-15619` | Creation reads only local Git; the controller fetches the base | G0's base rule keeps it |
| #1874, `src/lib/orchestrator/seatProjectIdentity.ts:38-46` | A seat keyed by a plain folder is re-keyed when the folder gains a repository | An orchestrator already runs in a plain folder |

## 3. What a pipeline already does with local Git and no remote

| Step | Where | With local Git and no remote, today |
| --- | --- | --- |
| Picker | `src/app/api/pipelines/preflight/route.ts:31`, `src/app/api/pipelines/source/route.ts:31` | Both call `preparePipelineRepository(repoDir, false)`: it walks the folder and writes nothing (`src/lib/pipelines/initializeRepository.ts:273-274`). The bare probe alone answers `not_git` (`src/lib/pipelines/preflight.ts:58`, `:66-68`). |
| Creation in a plain folder | `engine.ts:15589`, bound at `:1928`; `initializeRepository.ts:275-276`, `:315`, `:351`, `:354` | Builds a repository on `main` in a sibling temporary directory with one baseline commit authored by Delegatus, then moves `.git` and a `.gitignore` into the folder. A receipt is kept in `.git/delegatus-initialization.json` (`:36`, `:326`). |
| Bounds of the baseline | `initializeRepository.ts:118-120`, `:129`, `:133`, `:145`, `:322-323` | 2,000 entries, 32 MiB in all, 2 MiB per file and 4,000 bytes of path names. The whole inventory must also fit one bridge report of 8,192 bytes (`src/lib/bridge/types.ts:64`); an overflow there is reported with the same path-list message. A folder over any bound is refused. The first three bounds are environment settings (`:52-58`); the path-list bound and the omit list are constants. |
| What the baseline leaves out | `initializeRepository.ts:31`, `:136`, `:138`, `:144`, `:151-155`, `:172-180` | A file over 2 MiB; a file with a second hard link; a symlink or other special entry; a nested repository; a name the omit pattern matches (`*secret*`, `*credential*`, `build`, `out`, `dist`, `coverage`, `.config` and others); a file whose content matches a secret pattern. Each is written into `.gitignore` as a literal path and stays untracked afterwards. |
| Refused places | `initializeRepository.ts:65-75`, `:77-92`, `:134` | The home directory and its ancestors, a system path, the state directory, a folder inside another repository's working tree, and a folder holding a path name that matches a secret pattern. |
| A draft made from a conversation | `src/lib/pipelines/fromConversation.ts:149-155` | Runs the bare probe with no initialiser: a conversation in a plain folder is refused with "conversation requires an existing Git working copy". A repository with no commit is refused with "conversation requires a named branch with a commit" (`:166`). |
| Base | `git.ts:177`, `:281`, `:286-288`, `:300`; `engine.ts:15669`, `:11261`, `:11441` | With no `origin` the base is the local `refs/heads/<base>`. When the creator names no branch, creation records `main` (`engine.ts:15669`) and provisioning resolves `refs/heads/main` (`:11261`). A repository whose branch has another name, or one with no commit, parks there (`:11441`). The earlier reading cited `git.ts:299`; #3800 moved it to `:300`. |
| Delivery target | `git.ts:72-85`; `engine.ts:15693-15697` | A missing `origin` makes the lane local-only; `remote-branch` publication is refused there. |
| Stage checkout | `src/lib/pipelines/store.ts:2521-2527`; `git.ts:414-415`, `:430`; `preflight.ts:177-184` | A sibling directory `<parent>/<name>-pipeline-<id>` on a branch `pipeline/<slug>-<id>`, made by `git worktree add` from the base commit. It needs writable Git metadata and a writable parent directory, and it holds committed files only. The earlier reading cited the synchronous `git.ts:248`; the controller calls the asynchronous form at `:414-415` and `:430`. |
| Disk at lane start | `engine.ts:11324`; `src/lib/state/diskPressure.ts:31`, `:49-50`, `:179-181` | Provisioning waits below `min(2 GiB, 2% of volume capacity)` when capacity is known; without capacity it uses 2 GiB. A 40 GiB volume therefore waits below 0.8 GiB free. G1 separately plans for the checkout's required space. |
| Stage contract | `src/lib/pipelines/prompts.ts:123-136` | A writing stage commits on the lane branch; with no remote it is told to keep its commits local (`:135`). Agents and the controller carry their own commit identity (`src/lib/runtime/agentConfigSandbox.ts:91`; `initializeRepository.ts:165`), so nobody configures one. |
| Hand-over between stages | `prompts.ts:103-107`; `git.ts:888` | The previous stage's output is relayed in the prompt. Accepted work is committed by `commitPipelineStage`. |
| Read-only stage | `git.ts:916`, `:929-930`, `:934-936`; `src/lib/pipelines/stageAccess.ts:7`, `:19` | Settlement reads the checkout's status and head and fails the stage with "created a commit" or "modified the pipeline worktree"; declared outputs are excepted. (Earlier reading: `:915`, `:928-935`; one line lower since #3800.) |
| Review | `prompts.ts:117-121`; `src/lib/pipelines/types.ts:224-228`; `git.ts:1582-1601` | The reviewer reads the commits since the base. A review settles on the commit it was fenced to, read from a clean checkout on the lane branch. |
| Publication | `src/lib/pipelines/publication.ts:40-43` | Nothing is pushed without a delivery remote. |
| Merge | `src/lib/forge/autoMerge.ts:32-37` | The merge runner works through GitHub with `gh` only. No file under `src`, `scripts` or `bin` names `refs/delegatus/landed`, the landing ref of the Git-first design. |
| Merging by hand | `engine.ts:17262-17267`, `:18574-18576`, `:18584`; `autoMerge.ts:1008-1009`, `:1189-1204`, `:1384-1385`; `src/lib/forge/resolve.ts:27-33` | The retry action hands the lane to the merge admission. That refuses while the project's setting is off, whether the lane has no merge record (`autoMerge.ts:1192-1193`) or a stopped one (`engine.ts:18584`). It refuses a lane that completed before the setting was switched on (`autoMerge.ts:1194-1195`), and a lane with no pull request and no GitHub repository as having "no resolved repository" (`:1198-1202`). While the setting is off the runner cancels every queued merge (`:1008-1009`, `:1384-1385`). |
| Task completion | `autoMerge.ts:1713-1721` | A completed lane finishes its task when the project's merge setting is off (`:1715`). |
| After completion | `src/lib/pipelines/worktreeSweep.ts:72-73` | The result is on the lane branch in the sibling checkout, which the sweep keeps as `local-only-commits`. No code returns it to the folder. |
| Seeing what changed | `src/lib/pipelines/laneChanges.ts:15`, `:58-63`, `:85`, `:113-115`, `:126-129`, `:134`; `src/lib/laneReview/http.ts:60-72`; `src/components/laneReview/LaneReviewSheet.tsx:384`; `src/lib/i18n/en.ts:8002` | "Review changes" lists the first 200 changed files with text diffs and a line that counts the rest, which nothing can list (`laneChanges.ts:113-115`; `http.ts:67`; `LaneReviewSheet.tsx:384`). One file opens by its path over a pinned pair of commits, and the path is checked against the whole comparison (`http.ts:69`; `laneChanges.ts:126-129`). With no remote the merge-base read against `origin` fails and the base is the lane's `baseRef` (`:59-63`). A binary file is listed with no content (`:134`). |
| Going back | – | No action reverts a lane's result; nothing has landed to revert. |

An orchestrator already runs in a plain folder: seats are keyed by the folder
and re-keyed when it gains a repository
(`src/lib/orchestrator/seatProjectIdentity.ts:38-46`).

## 4. What an ordinary non-code folder lacks

| # | Gap | Evidence |
| --- | --- | --- |
| 1 | **Size limits.** The folder is refused beyond 2,000 entries, 32 MiB or 4,000 bytes of path names; about 130 ordinary file names are enough | §3 (`initializeRepository.ts:118-120`, `:133`, `:322-323`); N1, N2, S3 |
| 2 | **Large and binary files.** A file over 2 MiB is left out of the repository for good, so no stage sees it and no result can change it | `:144`; N3, N4 |
| 3 | **Left-out names.** Names that look like build output or secrets (`out`, `build`, `*secret*`), files whose text contains something like a password line, symlinks and nested repositories are left out the same way, and nobody is asked | `:31`, `:136-155`; N3 |
| 4 | **The person's own later changes.** A stage checkout is made from the last commit. Whatever the person changed or added since then is absent from it, and nobody commits for the person | `git.ts:414-415`, `:430`; N5 |
| 5 | **Landing with no forge.** The result stays on a branch in a sibling directory. The merge runner speaks only to GitHub, and the local landing of the Git-first design is unbuilt. A person cannot land it by hand either: the retry action refuses while the setting is off, and refuses a lane with no GitHub repository | `autoMerge.ts:32-37`, `:1192-1202`; `engine.ts:18584`; `worktreeSweep.ts:72-73` |
| 6 | **Seeing what changed, for documents.** A changed PDF is listed as binary with no way to open either version. The list shows the first 200 files and only counts the rest, so the 201st changed document cannot be opened | `laneChanges.ts:15`, `:85`, `:113-115`, `:134`; `LaneReviewSheet.tsx:384` |
| 7 | **Going back.** No action undoes a result | §3 |
| 8 | **Starts that fail.** A conversation in a plain folder cannot become a pipeline draft; a repository with no remote whose branch is not `main`, or with no commit, fails to resolve its base | `fromConversation.ts:149-155`; `engine.ts:15669`; `git.ts:300`; S1, S2 |

## 5. Measurements and probes

Rows are labelled N (the initialiser), R (plain Git on a document folder), F
(a fast-forward into a folder), A (the apply step) and S (the starts).

### 5.1 The product's initialiser on document folders (N)

Measured on 2026-11-10 with `preparePipelineRepository` from main of that
day, against folders made for the probe. `initializeRepository.ts` has not
changed since (`git diff` over the file is empty). On 2026-11-11 at
`803f12c1` a 200-file folder was refused with the N1 message (S3), and a
reduced N3 folder (two text files, the 3 MiB drawing, `out` with one file,
`secret-handling.pdf`) kept the same three files and left out the other three.

| # | Input | Result |
| --- | --- | --- |
| N1 | Files with 30-byte names | 120 files admitted; 140 and 200 refused: "project exceeds the initial commit path-list bound" |
| N2 | 2,001 one-byte files with short names; 20 files of 1.9 MB | Refused by the path-list bound; refused by the size bound |
| N3 | An office folder: two text files, a 3 MiB drawing, `secret-handling.pdf`, folders named `out` and `build` with one letter each, a note with a line "password: …", a symlink, an empty folder | Created. Three files are tracked: `.gitignore` and the two text files. The drawing, `secret-handling.pdf`, `out`, `build`, the note and the symlink are left out and written into `.gitignore`. The folder gains `.git`, a `.gitignore` of about fifty lines and a lock directory |
| N4 | A checkout made from that baseline | Holds the three tracked files |
| N5 | The person edits a tracked file and adds a file, without committing; a second checkout is made | The second checkout has neither the edit nor the new file. `git status` in the folder shows both as uncommitted |
| N6 | A second creation call on the folder | Nothing is written again |

### 5.2 Plain Git on a document folder (R)

Measured on 2026-11-10 on one Linux machine (24 CPUs, ext4, Git 2.43.0)
while it ran its usual agents, on 1,000 files of 64 KiB and six of 150 MiB,
incompressible, 963 MiB in all, with a warm page cache.

| # | Step | Result |
| --- | --- | --- |
| R1 | First `git add -A`; first commit | 25.1 s; 0.0 s. `.git` holds 968 MiB |
| R2 | `git status` with nothing changed | 0.0 s |
| R3 | `git worktree add` (a lane checkout) | 1.3 s; the checkout is another 963 MiB |
| R4 | Commit of one replaced 150 MiB file | 5.4 s; `.git` grows to 1,119 MiB |
| R5 | Merge of a lane branch into the folder while its owner has an untracked file and an uncommitted edit of another file | Succeeds in 0.2 s; both of the owner's files are intact |
| R6 | The same when the owner's uncommitted edit is in a file the lane changed | Refused before any change: "Your local changes to the following files would be overwritten by merge". No merge is left in progress |
| R7 | The same after the owner's edits were committed, with both sides having changed one binary file | A conflict on that file; the folder keeps the owner's bytes; `git merge --abort` returns the folder to its commit |
| R8 | `git revert -m 1` of an earlier landing | 0.2 s; the replaced file is the original again; the owner's other files are untouched; history keeps the landing and the revert; the replaced version stays readable from history |

### 5.3 A fast-forward into a folder whose owner has files Git does not track (F)

Measured on 2026-11-10 on the machine of §5.2.

| # | Step | Result |
| --- | --- | --- |
| F1 | `git merge --ff-only` while the owner has an uncommitted edit of a file the lane did not change | Succeeds; the owner's edit is intact |
| F2 | The same when the edit is in the file the lane changed | Refused before any change; the head does not move |
| F3 | The lane commits a file at a path where the folder holds a left-out file, one listed in `.gitignore` | The fast-forward succeeds and **overwrites the owner's file** with the lane's bytes. Git protects an untracked file only while it is not ignored |
| F4 | `git merge-tree --write-tree` of the owner's commit and the lane's, both having changed one file | Reports the conflict and writes nothing into the folder |

### 5.4 The apply step against a file saved in between (A)

The folder ignores `*.pdf` and `out/`. The lane adds `new.pdf`, `plain.txt`
and `out/x.txt`. A check of the paths the lane adds finds no collision, and
then the person saves a file. Measured on 2026-11-10 on the machine of §5.2,
with the native Git binary and a clean environment. A1 to A6 were repeated on
2026-11-11 with the native Git 2.43.0 binary and a clean environment, and
gave the same results.

| # | The person saves, then the product applies | Result |
| --- | --- | --- |
| A1 | The ignored `new.pdf`; `git merge --ff-only` | Exit 0. The person's bytes are replaced by the lane's |
| A2 | The same; `git merge --ff-only --no-overwrite-ignore` | Exit 1: "The following untracked working tree files would be overwritten by merge". The person's bytes stay, the branch does not move, no merge is left in progress |
| A3 | `plain.txt`, which no rule ignores; `git merge --ff-only` | Exit 1, the same message; the person's bytes stay |
| A4 | `out/x.txt` inside the ignored folder | Without the option: replaced. With it: exit 1, the person's bytes stay |
| A5 | `new.pdf`, after a commit of the owner's own, so that the product runs a real merge in the folder with `--no-overwrite-ignore` | Exit 0. The person's bytes are replaced. The option protects a fast-forward only |
| A6 | An ignored file at a path the lane does not write; with the option | Exit 0; the file is untouched and the result lands. No false refusal |
| A7 | A2, then the product prepares again away from the folder with the lane's file under a second name, and applies with the option | Exit 0. `new.pdf` holds the person's bytes and `new (result).pdf` the lane's |
| A8 | Undo. A landing removed a tracked `report.pdf`; a later snapshot left the name out; the person saved a new `report.pdf`; the revert of that landing is computed away from the folder and applied | Without the option: exit 0 and the person's file is replaced by the old version. With it: exit 1, the person's bytes stay |

The manual page git-merge(1) of Git 2.43.0 states the default: "Silently
overwrite ignored files from the merge result. This is the default behavior.
Use --no-overwrite-ignore to abort."

### 5.5 The starts, at `803f12c1` (S)

Run on 2026-11-11 through the real `resolvePipelineBaseAsync` and
`preparePipelineRepository`, from a scratch export, with a private home,
configuration, temp and state directory and the native Git 2.43.0.

| # | Input | Result |
| --- | --- | --- |
| S1 | A repository with no remote on `master` with one commit; the base the record carries when nothing was named (`main`) | `resolving pipeline base refs/heads/main: fatal: Needed a single revision`. Named `master`, the base resolves |
| S2 | A repository with no remote and no commit | The picker's check and the creation admission both answer ready; the base fails with the same message as S1 |
| S3 | The office folder of G0: 200 files with 32-byte names, a 3 MiB file, an 80 MiB file, a folder `out` with one file, `secret-handling.pdf` | The picker's check refuses: "project exceeds the initial commit path-list bound". No `.git` is written |

### 5.6 What the measurements mean

1. An ordinary office folder loses most of its content at the baseline (N3),
   and about 130 ordinary file names are enough to be refused (N1, S3).
2. A stage sees the last commit and nothing the person did afterwards (N5).
3. Tracking a document folder in Git costs its size once in `.git` and once
   more per lane checkout, and each replaced large file adds its size (R1, R3,
   R4).
4. Git brings a result into a folder with unrelated uncommitted changes, and
   refuses cleanly when they overlap (R5, R6, F1, F2). A merge can be computed
   without touching the folder (F4). Going back is one cheap command (R8).
5. By default Git does not protect a left-out file: a result that carries the
   same path overwrites it (F3, A1), and a comparison made beforehand cannot
   help with a file saved after it. One native option makes the fast-forward
   itself refuse (A2, A4), for an undo as well (A8), and it works for a
   fast-forward only (A5). So the landing has to be computed away from the
   folder and applied as a fast-forward with that option.

## 6. The managed folder

### 6.1 What it is, and its setting

A **managed folder** is a project whose repository the product created and
keeps. The receipt the initialiser already writes identifies it
(`initializeRepository.ts:36`, `:214-225`). One project setting, "Delegatus
keeps this folder's history", switches on everything in §6.2 to §6.7. The
setting is per project and off by default, and an install's administrator can
preset it. The plan of §6.2 shows it when the product is about to create the
repository, so a person turns it on with one switch at the first start. It
stays off for a repository a person brought.

The landing setting of the Git-first design ("land when the review passes",
off by default, per project) is a second, separate switch. §6.4 covers it
switched on, and §6.5 switched off.

### 6.2 Admission with a plan (gaps 1 to 3)

Before the first commit the picker shows a plan: how many files and bytes will
be tracked, what is left out and why, and how much disk the folder needs
(§7). The bounds become settings with larger defaults, set from a measurement
on the machine that runs the product. A folder beyond them is refused with
the numbers and one way on: a narrower folder.

Left out by default: files above the per-file bound, links, nested
repositories, the lock and temporary files office programs leave beside an
open document, and names or contents that match the secret patterns. The
build-output names of a code project are not applied to a managed folder, so a
folder called `out` is an ordinary folder. The creator may include a left-out
file or folder by name. The list of what stayed out is kept with the project,
shown on its page, and named in every stage's input: "these files exist in the
folder and are not in your checkout". A stage that needs one says so in its
report, and a review cannot pass work on a file it was never shown.

Today a path name that matches a secret pattern refuses the whole folder
(`initializeRepository.ts:134`). Before G1 keeps any refusal by a text
detector, it runs the detectors read-only over a real folder and counts hits
by class; a refusal stays only for a class whose hits are rare and true, and
every other class becomes a listed left-out entry the creator can include.

The initialiser's internals change with the bounds. Paths go to Git on
standard input, files are hashed as streams, the inventory is a file with a
count in the report, and the whole run moves to a worker process under one
deadline with a label monitoring can report. Today paths travel as arguments,
each file is read whole into memory, each Git call has 15 seconds and the
inventory must fit one report (`initializeRepository.ts:102`, `:168`, `:310`,
`:313`, `:322-323`). That fits 32 MiB and nothing larger. The worker is started
by the creation request itself, so no seat, project or agent-launch admission
can hold it on a fresh install.

### 6.3 Snapshots (gap 4)

The product commits the folder's current state on its base branch, with its
own commit identity (`initializeRepository.ts:165`), at two moments: when a
lane is created, and right before a result lands. A snapshot applies the
admission rules to new files and adds what it leaves out to the list. Its cost
follows what changed: Git skips files whose stat data is unchanged (R2), and
one replaced 150 MiB file took 5.4 s (R4). Two things follow. A stage sees the
folder as the person left it. And the person's own edits become versions in
history, although the person never committed anything.

### 6.4 Landing with no forge (gap 5)

This is the Git-first design's landing for a project without a remote
(`docs/design/git-first-forge-optional.md` §4.2.5, its slices S3 and S5, with
the answers of 2026-10-26): the reviewed head is merged into the base with a
merge commit; a clean checkout is fast-forwarded; otherwise the merge waits in
a separate ref and the card says so. A managed folder adds one apply step and
three rules.

**The apply step.** The product never merges inside the person's folder. It
computes the landing commit away from the folder (F4) and then moves the
folder to it with one Git command: a fast-forward told to leave ignored files
alone, `git merge --ff-only --no-overwrite-ignore`, the form provisioning
already runs at `git.ts:467`. Before it changes anything, that command refuses
when the folder holds a file it would write over: an uncommitted edit of a
tracked file (F2), a new file that no rule ignores (A3), or a left-out file
(A2, A4). Without the option Git replaces a left-out file silently (F3, A1).
The option works for a fast-forward only: a merge run in the folder replaces
the file even with it (A5). So the check that protects the person's bytes sits
inside the command that writes them, and a file saved a moment earlier is seen
by it.

What this does not cover, each with the check that owns it:

| Case | Why it is outside | Check |
| --- | --- | --- |
| A save inside the one command, between its own look at a path and its write | Not examined; probe A saves before the command starts | The design claims the command as the unit and nothing finer. G4's test injects the save between the product's comparison and the command (§9) |
| An edit that leaves every stat field Git compares unchanged | Git decides that a tracked file changed from its stat data. By default that includes the change time, which a write moves (git-config(1), `core.trustctime`, `core.checkStat`); a setting that turns those checks off, or a filesystem that does not keep change times, hides such an edit. Not probed | The product's own Git calls run with no system or global configuration (`initializeRepository.ts:162-166`); G2 keeps the folder's own configuration free of those settings and states what a snapshot does on the pilot folder's filesystem (§9) |
| A merge run inside the folder | The option does not protect it (A5) | The product never runs one there; G4 tests that only the fast-forward touches the folder |
| Another program of the same user writing during the command | The same as a save | The same as the first row |

1. **Snapshot first.** The product takes a snapshot, computes the landing and
   applies it. Only files the result changed are rewritten.
2. **Both changed the same file.** When the person and the lane changed one
   file and Git cannot combine them, as with any binary document (R7), the
   person's version stays in place and the lane's version lands beside it
   under a second name. The card lists such files. The folder never shows a
   half-merged state, because the merge is computed outside it.
3. **A left-out path is never written.** While it prepares a landing, the
   product compares every path the result adds with the files the folder
   holds outside the repository. A result that carries one of those paths
   lands that file beside the person's, under a second name, as in rule 2.
   This comparison decides which files land beside. The guard is the apply
   step.

**When the apply step refuses**, the person saved a file after the
preparation. The product prepares again: a new snapshot, the comparison of
rule 3, which now finds the file, and a new landing commit (A7). After three
refusals the result waits as "prepared" in the separate ref of the Git-first
design, with a note on the card, and the folder is as the person left it.

### 6.5 Applying by hand while the landing setting is off: apply once

The landing setting stays off by default per project, as decided on
2026-10-26. Where it is off, a finished lane's card says "ready" and offers
"Apply to the folder". Nothing on main can carry that request out (§3,
"Merging by hand"): the retry action refuses while the setting is off, with a
merge record or without one; a lane with no GitHub repository is refused for
that reason alone; and the runner cancels whatever is queued while the
setting is off. A new label on the existing action would answer 409. So G4
adds a server operation of its own, **apply once**:

- **Who asks.** A signed-in person, by the rule the review sheet already uses
  (`src/lib/laneReview/http.ts:36-42`). A request from an agent or a seat is
  refused. Where the setting is on, the runner lands by itself and no agent
  needs this operation; where it is off, "off" keeps its meaning: nothing
  reaches the folder unless a person asked.
- **Admission**, checked under the lane's write lock: the lane is completed
  and visible, its project has no remote, it has a passed commit and meets the
  review bar (the checks of `autoMerge.ts:1189-1190` and `:1196-1197`), and the
  lane branch still ends at the reviewed commit.
- **What runs.** The same landing as the automatic path, for this one lane:
  the landing head, the apply step and the three rules, serialized with every
  other landing of the repository. It never enters the queue that the runner
  cancels.
- **The setting** is neither read nor written. After the landing it is still
  off, and the next finished lane waits for its own request.
- **Once.** The answer comes from the lane's landing record and from ancestry.
  When the base already contains the lane's landing head, the answer is
  "already applied" and nothing is written. A request for a prepared landing
  finishes that landing and makes no second one. A result that was undone
  returns by undoing the undo.

With the setting off a lane's task is finished when the lane completes
(`autoMerge.ts:1715`), so apply once changes the folder and the landing record
and no task.

### 6.6 Seeing what changed (gap 6)

The "Review changes" sheet stays the place. It gains three things.

- **The whole list.** The list is read in pages of 200 over the pinned pair of
  commits the sheet already carries: a request names the base, the head and
  an offset, and the answer carries that page, the total and the same pair.
  Two commit identifiers name one fixed comparison in one order, and every
  page request names them, so a later page cannot shift and a new commit on
  the lane branch cannot change a page. The sheet shows "1–200 of 431" and a
  control for the next page in place of today's line that only counts the
  rest. A file opens by its path over the same pair, whichever page listed
  it; the server already checks the path against the whole comparison
  (`laneChanges.ts:126-129`).
- **Both versions of a binary file.** A changed binary file opens in both
  versions, read from Git by the pinned base and head.
- **History.** The folder gets a history: its landings and snapshots, newest
  first, each landing with its list of changes, paged the same way over that
  landing's own pair of commits.

### 6.7 Going back (gap 7)

"Undo this result" on a landing, from the card or from the history, reverts
that landing's merge commit away from the folder and brings the revert in
through the same apply step. R8 measured a revert at 0.2 s, with the person's
other files untouched and both steps kept in history. The step protects an
undo as it protects a landing: a left-out file the person keeps at a path the
undo would restore stays (A8), and the restored version lands beside it, as in
a landing. When a later change touched the same file, the rule for "both
changed" applies. Nothing is ever removed from history, so an undo can itself
be undone.

### 6.8 What stays as it is, and what a review can rely on

The lane itself is unchanged: a checkout per lane, a branch, commits by
writing stages, the relay between stages, parallel lanes on one project.

- **A stage never works in the person's folder.** The person's files change
  only through a landing or an undo, each a commit.
- **A review judges a commit.** Its identifier is a hash of the content, so
  the bytes a reviewer read are the bytes that land. Before a pass moves to a
  later head, the engine checks that the passed commit is its ancestor
  (`git.ts:1184`; the earlier reading cited `:1183`), and the Git-first landing
  refuses a rewritten branch.
- **A read-only stage** is checked at settlement, as today (`git.ts:916`,
  `:929-930`): a commit or a changed file in its checkout fails the stage.
  Nothing prevents the write beforehand, and nothing in this design claims
  that.
- **History lives in the folder's `.git`** and is written by the user who
  runs the product. It protects against accident and gives undo. A process of
  that same user that sets out to destroy it can do so; a backup of the
  folder is the answer to that, and this design adds none.

## 7. Costs and bounds

From the measurements of §5.2, on 963 MiB of incompressible files:

| Cost | Measured | Consequence |
| --- | --- | --- |
| First commit | 25.1 s; `.git` takes 968 MiB | The folder's size once more on disk |
| Each lane checkout | 1.3 s; 963 MiB | The folder's size again per running lane |
| Each replaced large file | 5.4 s; 151 MiB more in `.git` | History grows by the size of every changed binary version |
| Landing, undo | 0.2 s each | – |

So a first lane on a folder needs about twice the folder's size free, each
further running lane once more, and history only grows. The design answers
with bounds and plain numbers:

- The plan refuses a folder whose need exceeds the free space.
- A lane start adds the checkout's tracked size to the free-space wait that
  provisioning already runs (`engine.ts:11324`; `diskPressure.ts:31`,
  `:179-181`).
- The project page shows what the history takes.

Proposed defaults, to be set from a measurement on the target disk in G1:
20,000 entries, 4 GiB tracked, 512 MiB per file. Initialisation and snapshots
run in a worker under one deadline, outside the controller's pass, and their
cost follows the bytes that changed. Pruning old versions and partial
checkouts are deferred (§11).

## 8. Slices

All are open-core lanes with one generic purpose: pipelines on local Git with
no forge, in any folder.

### 8.1 Slices, in order

| # | Slice | Needs first | Outcome and acceptance |
| --- | --- | --- | --- |
| G0 | **The acceptance case as a failing test, and the starts that fail today** | – | A test on an office folder (200 files with 30-byte names, a 3 MiB document, an 80 MiB binary, a folder named `out`, a file named like `secret-handling.pdf`): a build, a review, a fix and a second review complete with no remote; every stage sees every admitted file; the result is in the person's folder; "what changed" shows it; undo restores the folder; the test's ports refuse every fetch, push and forge command. It fails on main for the reasons of §4 and is committed as an expected failure (§8.2). In the same slice: a conversation in a plain folder becomes a draft the way creation admits it; with no remote and no branch named, the base is the checked-out branch; a repository with no commit gets a refusal that names the fix. |
| G1 | **Admission of an ordinary folder**: the plan, bounds as settings, streamed hashing in a worker, the left-out list with inclusion by name, the managed-folder setting | G0 | The picker admits the folder of G0 and shows its plan; the 3 MiB document and the `out` folder are tracked; the file with the secret-like name is listed as left out and becomes tracked when the creator includes it; a folder beyond a bound is refused with the numbers; time and disk for a 2 GiB folder are recorded. |
| G2 | **Snapshots** at lane creation and before a landing | G1 | A file the person changed or added after the first commit is in the next lane's checkout; a file open in an office program does not break a snapshot. |
| G3 | **The landing record and completion from ancestry**: slice S3 of the Git-first design | – (independent) | As that design states: a prepared landing finishes nothing; a task finishes when the base contains the landing head. |
| G4 | **The local landing**: the part of the Git-first slice S5 that serves a project with no remote (its landing head, its gate kinds, prepared and applied), with the apply step and the three rules of a managed folder, and the apply-once operation for a project whose setting is off | G2, G3 | The acceptance case of G0 reaches "the result is in the person's folder". An uncommitted edit of the person's to an unrelated file survives a landing. An edit of the person's to a file the lane changed leaves the person's version in place and the lane's beside it. A lane that commits a file at a left-out path leaves the person's file as it was. **A left-out file that the person creates after the product's comparison and before the apply keeps its bytes, and the lane's version lands beside it** (A2, A7); the test injects the save between the two steps. A lane branch rewritten after its review does not land. **Apply once:** on a completed local-only lane with no remote, no pull request and the setting off, a person's request applies the result and the setting is still off afterwards; a second request answers "already applied" and writes nothing; a request from an agent is refused; a lane that is not completed, or whose branch moved past its reviewed commit, is refused. |
| G5 | **Seeing and going back**: the whole list of changes in pages over the pinned pair; both versions of a binary file in the review sheet; the folder's history; "Undo this result" through the apply step | G4 | **A lane that changed 201 files lists all 201 across two pages with "of 201" shown, and the 201st opens in both versions. A commit added to the lane branch between the two page requests changes neither page.** A changed PDF opens in both versions. Undo of a landing restores the earlier bytes and leaves later unrelated work alone. **A left-out file the person keeps at a path an undo would restore keeps its bytes, and the restored version lands beside it** (A8). G0 passes in full. |
| G6 | **Surfaces and copy**: what the picker says will happen to a plain folder, the plan, the card states (ready with "Apply to the folder", applied, prepared, kept both), the paged list with its count and next-page control on the desktop sheet and the phone sheet, the history | With G1, G4, G5 | Rendered in both languages and themes on a phone and a desktop width through the existing kanban driver. |

Order: G0, G1, G2; G3 beside them; then G4, G5; G6 with each surface.

### 8.2 G0 in detail

G0 ships this file, the acceptance case and the three starts in one pull
request.

#### The acceptance case, committed as an expected failure

The runner is `bun test` (`package.json:48`) under the Bun the `Dockerfile`
pins (`npm install -g bun@1.4.0`). Bun marks an expected failure with
`test.failing(name, body)`, which the installed types declare
(`node_modules/bun-types/test.d.ts:505-515`). A probe on 2026-11-11 under Bun
1.4.0 showed:

| Form | Body | Console | JUnit report |
| --- | --- | --- | --- |
| `test.failing` | throws | counted under "pass" | a `testcase` with its name and no `failure` |
| `test.failing` | passes | `(fail)`, "this test is marked as failing but it passed. Remove `.failing` if tested behavior now works"; exit 1 | `<failure message="test marked with .failing() did not throw">` |
| `test.todo` with a body | not run without `--todo` | counted under "todo" | `<skipped message="TODO"/>` |

The touched-tests lane of the pre-push gate reads that JUnit report
(`scripts/local-gate-tests.ts:177-197`, `:292`): a `testcase` with no
`failure` is a pass, and a skipped one counts as removed. So the case uses
`test.failing`, one per clause, and no `test.todo`. On main today every clause
throws, each test passes as an expected failure, and the pre-push gate, the
required checks and the nightly full run stay green. When a later slice makes
a clause hold, that clause's test turns red at once with Bun's instruction to
remove `.failing`; the slice that turns a clause on changes it to `test` in the
same change.

`test.failing` passes on any throw, including a broken fixture. The case is
therefore split into steps that observe and steps that judge:

1. An ordinary `test` builds the office folder under the test's own temporary
   directory: 200 files with 30-byte names, a 3 MiB document, an 80 MiB binary
   of deterministic bytes, a folder `out` with one file, and
   `secret-handling.pdf`. Every repository the test makes uses its own Git
   identity, with the inherited author, committer and `GIT_*` variables
   cleared and the native Git binary checked. It installs ports that refuse
   and record any `gh` call and any Git subcommand that reaches a remote
   (`fetch`, `push`, `pull`, `ls-remote`, `clone`, `remote update`) on both
   of the engine's command ports, `exec` and `provisionExec`; the fixture
   stubs agent launches, so no engine process starts. The initialiser runs
   its local Git calls through `realExec` directly
   (`initializeRepository.ts:168`, `:288`), outside those ports, so the case
   also asserts that the folder never gains a remote, as
   `repositoryInitialization.test.ts:284` and `:296` do.
2. An ordinary `test` drives the case through existing code only and records
   each step's outcome; it records a refusal as an outcome and goes on.
   Admission goes through `defaultPipelinePorts().preflightRepo`, as
   `src/lib/pipelines/repositoryInitialization.test.ts:30` does; creation
   through `createPipelineFromRequest`; stages through the engine fixture
   (`src/lib/pipelines/engine.fixture.ts:124`, `:336`), the test acting as
   each stage's agent: the build adds a text file and replaces the 3 MiB
   document, the first review (read-only) fails with one finding, the fix
   edits the text file, the second review passes. "What changed" reads
   `laneChangeSummary` and `laneFileDiff`. Apply and undo have no product
   operation yet; they are steps that record "absent" and name the slice that
   adds them. This test asserts where the case stops today (admission, "project
   exceeds the initial commit path-list bound") and that the refusal log of
   the ports is empty.
3. One `test.failing` per clause, each a pure assertion over that record, so
   that the only thing that can throw inside it is its own expectation. Each
   name carries the clause and the gap that blocks it today:

| Clause | Blocked today by | Expected to hold after |
| --- | --- | --- |
| A build, a review, a fix and a second review complete with no remote | Gap 1: the path-list bound refuses the folder | G1 |
| Every stage sees every admitted file (all but `secret-handling.pdf`, which stays listed as left out) | Gaps 1, 2, 3 | G1 |
| The result is in the person's folder | Gap 5 | G4 |
| "What changed" shows the result, every changed file listed and each one openable | Gap 6 | G5 |
| Undo restores the folder | Gap 7 | G5 |

A defect in the fixture or the ports fails step 1 or 2 and turns the file red;
it cannot hide inside an expected failure. Each later slice moves the stop
asserted in step 2 forward and turns its clauses into ordinary tests. G1 wires
admission to the plan with the managed-folder setting on; G4 replaces the
absent apply step with apply once; G5 replaces the absent undo and, with the
last clause, removes the stop assertion.

The file references only exports that exist at its base, so the typecheck
passes. It runs by path through `scripts/gate-slot.sh` with a private `HOME`,
`XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR`, and `LLV_VIEWER_CONTROL_URL`
on a closed port. Today it writes about 83 MiB and stops after the walk of the
folder. From G4 on, a lane checkout and the folder's history add about three
times that, all under the test's own temporary directory, which the file
removes.

Proposed path: `src/lib/pipelines/ordinaryFolderAcceptance.test.ts`.

#### The three starts

Each comes with a test that fails at `803f12c1` and passes after the change.

**A conversation in a plain folder becomes a draft.** The preview runs the
same read-only check as the picker (`preparePipelineRepository(cwd, false)`,
as `src/app/api/pipelines/preflight/route.ts:31` does), writes nothing, and on
success says that creating the draft will create a local repository; on a
refusal it answers with that check's own detail. Create runs the creation
initialiser (the function bound at `engine.ts:1928`) on the person's explicit
request, then reads the branch and head of the new baseline and pins them, as
for any repository (`fromConversation.ts:161-170`, `:308-309`). The task keeps
its project through the folder-to-repository succession the initialiser
records (`initializeRepository.ts:202`; the project check at
`fromConversation.ts:159`). The action's authority rules and its other
refusals stay as they are. This changes one row of
`docs/design/start-pipeline-from-conversation/implementation.md` (`:34`,
`:173`, "never initialize a repository"), for this requirement; the preview
stays read-only as that design asked.
Tests in `src/lib/pipelines/fromConversation.test.ts`: a plain folder gives a
preview that can create, with no `.git` afterwards; create stores a draft
pinned to the baseline commit on `main`, one commit authored by Delegatus, and
the task's project still matches; a folder over a bound is refused by preview
and create with the initialiser's detail, and nothing is written. Today the
preview refuses with `SOURCE_WORKING_COPY_UNAVAILABLE`.

**With no remote and no branch named, the base is the checked-out branch.**
When a creation request names neither `baseBranch` nor `baseRef` and the
repository has no `origin` (`git remote get-url origin` exits 2, the test
`git.ts:286-288` and `engine.ts:15621` already use), creation reads the
checked-out branch with one local read (`git symbolic-ref --quiet HEAD`,
stripping the full `refs/heads/` prefix so a same-named tag cannot change the
branch name) and records it as the lane's base branch in place of `main`
(`engine.ts:15669`); a draft records it the same way. Nothing is fetched,
which keeps the rule of `engine.ts:15613-15619`. Unchanged: a repository with
`origin`, a named branch or commit, a detached checkout (keeps `main`), and a
folder the product initialised (its branch is `main`).
Test in `src/lib/pipelines/engine.creation.test.ts` with real Git: a
repository on `master` with one commit, no remote and nothing named gives a
lane whose base is `master`; provisioning resolves `refs/heads/master` and
runs no fetch. Today the base is `main` and the lane parks (S1). Existing
cases that must keep passing: `src/lib/pipelines/git.test.ts:79-95` and
`:806-831`, `engine.creation.test.ts:2589-2600`.

**A repository with no commit gets a refusal that names the fix.** In the
same place, when the request pins no commit and the repository has no
`origin`, creation checks that the branch the base will resolve to (the named
one, or the checked-out one) has a commit. If it has none, creation answers
409 before storing anything. The message says the repository has no commit yet
and names one way to make the first one. The draft from a conversation, which
refuses an unborn branch at `fromConversation.ts:166`, carries the same text.
Tests in `engine.creation.test.ts` (no record stored; the message names the
fix) and `fromConversation.test.ts`. Today creation accepts the repository and
the lane parks with the base message (S2).

#### Files other open work is changing

`engine.ts` is changed by the open #3710, #3801 and #3802. A three-way
`git merge-file` of a sketch of G0's creation edit (four lines after
`engine.ts:15627`, one changed line at `:15669`, one line after `:15671`)
against each branch's head and merge base gave no conflict with #3710 or
#3801. #3802 conflicts once with main alone, and the sketch adds no conflict.
`fromConversation.ts` and `git.ts` are unchanged by all three.
`engine.fixture.ts` is changed by #3802; G0 imports from it and does not edit
it. #3756 changes only a design file, whose plan changes
`initializeRepository.ts`; G0 leaves that file alone, and G1 reads that
change first.

The new Git reads are local and run at creation only when the request pins no
commit: `git remote get-url origin`, and, with no `origin`, the branch read and
the commit check. A test stub that answers every Git call with exit 0 and
empty output reports an `origin` and keeps today's path; G0 runs
`engine.creation.test.ts` and the engine test files that create lanes without
a remote to confirm it.

Checks for G0: the touched test files by path (the acceptance file,
`fromConversation.test.ts`, `engine.creation.test.ts`, `git.test.ts`) in
isolated state, then the project's own required checks at publication
(typecheck, build, scope, privacy-publication and the rest).

### 8.3 The office folder of G0, slice by slice

| After | What happens to the office folder |
| --- | --- |
| Today, G0 | The picker refuses it (path-list bound). The acceptance case records that stop; five clauses are expected failures |
| G1 | The plan admits it with the managed-folder setting on: its 203 other files, about 83 MiB, are tracked; `secret-handling.pdf` is listed as left out until the creator includes it. A build, a review, a fix and a second review complete; every stage sees every admitted file. The result stays on the lane branch |
| G2 | A document the person edits after the first commit is in the next lane's checkout |
| G3 | The lane carries a landing record; a prepared landing finishes nothing |
| G4 | "Apply to the folder" brings the result in; the person's later edits and left-out files keep their bytes; where both changed a document, both versions are in the folder |
| G5 | "What changed" lists every file and opens both versions of the replaced document; undo restores the folder. The case passes in full |
| G6 | The plan, the card states and the paged list are rendered in both languages and themes |

### 8.4 Relation to the Git-first design

G3 is its slice S3 unchanged. G4 takes the no-remote part of its S5 first and
alone, and adds one thing that design lacks: apply once. Its §4.6 keeps the
retry action as "retry the landing", which serves a project whose setting is
on. That changes the order inside S5; its decisions stay as they are. The
candidate protocol for a protected GitHub base, the risky half of S5, is not
needed here. That design ships its S4 before S5 so that release and update readers
can judge a landing; those readers serve a repository with a remote, so G4
does not wait for them. Before G4 starts, this is confirmed against the open
changes of that day. Its S6 enables the landing switch for a project without
GitHub (`src/components/MergeOnReviewRow.tsx:63-89` disables it today) and is
needed for a person to see that setting; an install's administrator can preset
it before then. Its S1, S2 and S7 concern projects with a forge and are not
needed for a managed folder. No code of S3 is on main yet: no file under
`src`, `scripts` or `bin` names `refs/delegatus/landed`, so G3 is built from
that design.

None of these lanes changes a live merge, check or branch-protection setting.

## 9. What could not be confirmed, and where I looked

| Unknown | Where I looked | Consequence |
| --- | --- | --- |
| The cost of Git on a real disk and on real documents | Measured on one machine only, on incompressible synthetic files, with a warm page cache (§5.2) | G1 measures on the target and sets the bounds. Real documents compress and differ |
| Which lock and temporary files office programs leave in a folder | Not examined on real folders | G2 collects them from a pilot folder |
| Whether a save can fall inside one Git apply command, between its own check of a path and its write | Not examined; probe A saves the file before the command starts | The design claims the command as the unit and nothing finer (§6.4). G4's test injects the save between the product's comparison and the command |
| Whether the filesystems people keep documents on (network shares, synced folders) keep the change time Git's default stat check relies on | git-config(1) on `core.trustctime` and `core.checkStat` only; nothing was run on such a folder | An edit hidden from the stat check is seen by neither a snapshot nor the apply step. G2 states the behaviour on the pilot folder's filesystem |
| How often the secret detectors hit on real document folders, by class | Not run; no real folder was read | G1 counts before it keeps any refusal (§6.2) |
| The apply step on the Git that macOS ships | Probe A ran on Linux with Git 2.43.0 only. The product already runs `merge --ff-only --no-overwrite-ignore` (`git.ts:467`) and `merge-tree --write-tree` (`git.ts:1101`), and handles the Git 2.39 merge-tree (`git.ts:1152-1153`) | G4 runs its apply-step tests on the macOS job as well |

## 10. Open points

These are for the later slices to settle in their own designs. None needs an
answer before G0.

- **G4 writes to two stores.** The landing record lives in the product's
  state; the folder moves in Git. G4's design states what a restart between
  the two writes does, and recovers by ancestry: the folder's head either
  contains the landing commit or it does not.
- **G1 and the project-start work.** The open #3756 plans changes to
  `initializeRepository.ts` (an operation marker and checkpoints around each
  ignore-file append). G1 changes the same file and reads that change first.
- **The 2026-10-26 answers** are not written into
  `docs/design/git-first-forge-optional.md`, whose status still reads "needs
  the operator's answers". G3 and G4 build on the answers as recorded in §2;
  that file is not changed by this lane.
- **Two switches.** The managed-folder setting and the landing setting are
  separate (§6.1). G6 decides how the plan and the project page present the
  pair.

## 11. Deferred — not currently justified

- A pipeline with no repository at all: stages working in the person's folder
  itself, sealed copies of every byte at stage boundaries, read-only views,
  a kernel write rule for read-only stages, and a version store of the
  product's own. The requirement accepts Git underneath, and Git already
  gives versions, comparison and revert.
- A repository kept outside the folder as the store of such a lane.
- For managed folders: pruning old versions from history; a partial checkout
  for a lane that needs one subfolder; restoring a single file from any point
  of history; a "save a version now" button; choosing per file between the
  person's version and the lane's when both changed it.
- Making the first commit for an existing repository that has none. G0 names
  the fix instead; such a repository was made by someone who ran Git.
- An earlier refusal in the picker for a repository with no commit. G0
  refuses at creation; what the picker says belongs to G6.
- The other slices of the Git-first design (its S1, S2, S4, S7 and the
  protected-base half of S5). They belong to that design.

## 12. Validation against the requirement

| The requirement asks | Where this design answers |
| --- | --- |
| Start in any folder, with as little setup as possible | Plain folders already start (§3); G0 opens the conversation draft and fixes two starts that fail; G1 admits an office folder with a plan |
| An orchestrator in the project, and the pipeline runs | Seats already run in a plain folder (§3); nothing to build |
| No GitHub, no sign-in, no pull request | A lane with no remote is local-only today; G4 lands with no forge; G0's case refuses every forge command |
| Stages hand work to one another | Unchanged lane mechanics (§6.8); G0's case runs build, review, fix and review |
| Changes can be seen | G5: the whole list, both versions of a document, the folder's history |
| Changes can be undone | G5: undo through the same protected apply step |
| The person types no Git command | The product creates the repository, takes snapshots, lands and undoes; the surfaces use no Git word (§6.1, G6) |

## 13. Evidence register

| Item | How it was read | When |
| --- | --- | --- |
| Line anchors | `sed -n` and `grep -n` on the pipeline checkout at `803f12c1`; `git diff` from the earlier reading's base to `803f12c1` over every cited file (only `git.ts` and `en.ts` changed; `en.ts:8002` holds). Before finishing, main had moved one commit to `2449d4c3`, which changes none of the cited files | 2026-11-11 |
| N, R, F and A rows | Carried over from runs of 2026-11-10 on the data sets stated in §5 | 2026-11-10 |
| S1 to S3 and a reduced N3 | A script in the stage's scratch directory importing the real `initializeRepository.ts` and `git.ts` from a scratch export of `803f12c1`, with a private `HOME`, configuration, temp and state directory, a closed control URL, and `PATH` limited to the system directories so the native Git 2.43.0 ran | 2026-11-11 |
| A1 to A6 again | `/usr/bin/git` (an ELF binary, version 2.43.0) under `env -i` with system and global configuration off, in throwaway repositories | 2026-11-11 |
| `test.failing` and `test.todo` behaviour | A three-test file under Bun 1.4.0 with `--reporter=junit` | 2026-11-11 |
| Overlap with open work | `gh pr view` file lists of #3710, #3731, #3756, #3795, #3801, #3802; head and merge-base copies of `engine.ts`, `fromConversation.ts` and `git.ts` fetched read-only and merged with `git merge-file` | 2026-11-11 |
| Earlier answers | Searches of earlier conversations and of project memory; `docs/design` searched for plain folders, initialisation and the landing ref; the records of §2 | 2026-11-11 |
