# Hidden project files: what the file routes serve

Status: implemented policy, with baseline observations at `6a8da56e` (2026-11-14).

## 1. Requirement

Source: an autonomous finding recorded on 2026-11-11 during the read-only
verification of the 1.15.0 security audit (findings 6–9, revision `692e5338`),
pinned for this lane on 2026-11-14. A hidden project file must not be readable
through the file routes by any spelling of its path: directly, through a link,
or from a hidden folder with no reason to be served. Images and reports agents
link from worktree checkouts and evidence directories keep opening.

## 2. Consumers and baseline behaviour

The artifact, image and frame routes admit a path through
`src/lib/artifact/localFile.ts`: `readablePlace` selects a kept-copy candidate
for a gone file, `admittedAs` judges the written path and copy provenance,
`realpathAdmitted` judges the resolved one. The picture store's writer
(`reportMedia/store.ts:189-214`) and the task album (`taskAlbum/album.ts:76-93`)
reuse them. **Project** roots (recorded project folders, session cwds and
checkout roots, pipeline worktrees, manual projects, `<state>/scratch`;
`scanner/projectDirectories.ts:68-90,160-162`) serve PDF, images and bounded
text. **Evidence** roots (`<state>/evidence`, `/var/tmp` or
`LLV_EVIDENCE_ROOTS`, `<state>/report-media`) serve rasters only.

Consumers put hidden folders **below** a root: `.worktrees/<name>` and
`.claude/worktrees/<name>` checkouts (`scanner/describe.ts:298-326`);
`.artifacts/`, which prototype input advice names as a fallback
(`prototypeReview/input.ts:60`) and where the controller leaves stage hand-offs
(`pipelines/controllerArtifacts.ts:21`); preserved stage evidence at
`<state>/evidence/attempt-temp/<key>/files/…`, which keeps `.artifacts` in its
path (`runtime/attemptTempEvidence.ts:65,83`). Hidden folders **above** a root
are normal: a Codex checkout at `~/.codex/worktrees/<hash>/<repo>` or a sibling
checkout under a hidden home folder is its own root, and the state directory
lives under `~/.config`. Current capture drivers allocate fresh temporary run
directories through `scripts/capture-directory.ts:createCaptureDirectory`;
the board geometry driver uses that allocator. Their current output location
is separate from the `.artifacts` advice and controller consumers.

Baseline cause: `classifyArtifact` reads only the written base name (`classify.ts:55-61`);
no route classifies the real path, the image route never classifies
(`image/route.ts:64`), and nothing judges folder names.

## 3. Reproduction

`bun test probe/hiddenFiles.probe.test.ts` and `probe/hiddenRoots.probe.test.ts`
from a `git archive` export of `6a8da56e`, through `scripts/gate-slot.sh`, with
fresh scratch HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR and
`LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`; 2026-11-14 10:41 and 10:47 UTC,
exit 0. Fixtures: a registered repository `<proj>` with three nested
worktrees reached through it, a Codex checkout registered as its own root. The
real GET handlers were called with only `Host: 127.0.0.1`.

| Request | Status |
|---|---|
| artifact `.env.local` | 415 |
| artifact `alias.txt` → `.env.local`; chain `chain1.txt` → `chain2.txt` → `.env.local`; a link named `suffix.txt:12` → `.env.local`; Codex checkout `alias.txt` → `.env.local` | 200, file text |
| artifact `.meta/notes.txt`, also as `sub/../.meta/…`, `file://…`, via link `meta-link` → `.meta`; `.worktrees/wt-a/.meta/notes.txt` | 200 |
| `.hidden.png` artifact / image; image `alias.png` → `.hidden.png` | 415 / 200; 200 |
| frame: report dir `alias.txt` → `.env.local`, `.meta/notes.txt`; meta read of `.meta/r2/index.html` | 200; 200, scope minted |
| image: kept `.hidden-kept.png` after deletion; `<evidence>/.cache-x/shot.png` | 200 |
| linked-checkout keep cases in §8, verified in separate baseline keep runs | 200, same bytes |

## 4. Open point 1: credentials in hidden tool folders

On the baseline, by extension, `.git/config`, `.git/COMMIT_EDITMSG`, `.git/hooks/*.sample`,
`.aws/credentials`, `.ssh/id_ed25519`, `.npmrc`, `.git-credentials` and
`.terraform/terraform.tfstate` answer 415. Tool configuration with a text
extension answers 200: `.claude/settings.local.json`, `.codex/config.toml`,
`.cursor/mcp.json`, `.vscode/settings.json`, `.config/gh/hosts.yml`,
`.docker/config.json`, `.next/required-server-files.json`, `.git/gc.log`. Every
refused file above also answers 200 through a `.txt` link in the project
(`via-config.txt` → `.git/config` and four more). The implemented hidden-component
rule refuses these hidden paths and their aliases with 403.

## 5. Open point 2: another local user, keyless

Stated from the code; this lane changes none of it. The Viewer binds 127.0.0.1
(`bin/cli.mjs:48`); loopback is shared by every account (`proxy.ts:118-119`).
Without `LLV_TOKEN` the perimeter admits every request (`proxy.ts:105-108`;
observed: a Host-only request passes, and is refused with 403 once a key is
set). The Host gate wants only an allowed name; the cross-origin gate refuses
only a foreign `Origin` or cross-site `Sec-Fetch-Site`, which non-browser
clients do not send (`sameOrigin.ts`); a solo install applies no workspace
filter (`team/workspaceRoute.ts:23-27`). So another account reads everything
these routes serve the operator, with the operator's permissions: files it
cannot open itself (a 0600 `.env.local`, stage scratch made 0700,
`structuredSpawn.ts:204-212`) and report frames, since a Host-only meta read
mints the scope. The recorded keyless decision
(`docs/security-audit-low-findings.md:70-72,177`) also lets such a client open
a solo session, so these routes are not its widest reach.

## 6. Options

1. Refuse hidden file names only, on both paths: `.meta/notes.txt`,
   `.claude/settings.local.json` and links into hidden folders stay open.
   Fails the outcome.
2. Refuse every hidden component below the root: breaks nested worktrees,
   `.artifacts/` and preserved evidence. Fails the keep requirement.
3. **Recommended:** option 2 with three passages the product itself creates,
   checked inside the shared admission so no route holds a copy. Per-route
   calls were rejected: the image route already drifted (`.hidden.png` 200
   against 415).

## 7. The rule

A hidden component is one whose name starts with `.`. Only components **below**
the root are judged; the root's own components stay out of it. A path is refused when, below
**any** allowed root of its admission kind that contains it, its file name is
hidden, or a folder component is hidden and is none of the passages
`.artifacts`, `.worktrees`, or `.claude` directly followed by `worktrees`. Both
kinds share the passages, since evidence roots hold copies of stage trees; the
kind still decides the served types. Checked on:

1. the requested path: `readablePlace` returns a refused path unchanged, so no
   kept copy stands in; under no root (deleted checkout, temp root) its file
   name is still checked;
2. the place read, in `admittedAs`;
3. the real path, in `realpathAdmitted` against the real roots, which is the
   path `openAdmitted` pins the descriptor to;
4. the picture store's writer, below the temp root for a temp-root picture.

Kept-copy admission also requires `hiddenPathPolicy: 1` on an indexed row
for the stored bytes (`reportMedia/lookup.ts:reportMediaCopyAllowed`). The
writer records it only after checking both source paths and copying from the
admitted descriptor. Legacy rows remain parseable for retention, but their
copies are refused through fallback, direct hash paths, aliases and frame
assets. A deleted visible alias cannot prove where an old writer read. Even
when its original project and hidden target survive, its legacy copy answers
403. The album inherits this refusal. A still-present admissible source can
be copied again; matching size and mtime alone never certify a legacy copy.
Newly verified copies continue serving after their source or checkout is gone.
Unverified legacy copies include legitimate deleted pictures whose provenance
is now unknowable. Those files remain on disk under normal retention; a
surviving admissible source can be copied again with proof.

Routes keep their codes: 403 `access-denied` (artifact), 403 `path not allowed`
(image), 403 (frame); a refused meta read mints no scope. `classifyArtifact`
keeps its base-name rule as the client's preview hint. The comment at
`artifact/route.ts` now states: reads are confined to recorded projects,
their checkouts, manual projects and the stage scratch, plus rasters under the
evidence roots and the picture store; the home directory is never a root.
Visible change: links into committed hidden folders (`.github/`,
`.claude/skills/`) show the existing refused state (the task files view still
shows such files a lane changed, from Git objects), and a direct `.env.local`
answers 403 where it answered 415.

## 8. Tests

In each route's own test file, isolated HOME and state. Ordinary file cases
use plain directories. The shared keep fixture (`artifact/localFile.fixture.ts`)
creates a real Git repository and linked Codex worktree: a plain Codex-shaped
directory does not establish checkout admission on the baseline. Paths are
under `<proj>` unless a root is named.

**Refuse** (red on `6a8da56e`, green on the head, no fixture text in the body):

- artifact, 403 `access-denied`: `alias.txt` → `.env.local`; `chain1.txt` →
  `chain2.txt` → `.env.local`; a link named `report.txt:12` → `.env.local`; a
  file `.meta/notes.txt:12`; `.meta/notes.txt` plain, as
  `sub/../.meta/notes.txt`, as `file://…`, via `meta-link` → `.meta`;
  `.claude/settings.local.json`; `via-config.txt` → `.git/config`;
  `.worktrees/wt-a/.meta/notes.txt`; `.worktrees/wt-a/alias.txt` →
  `.env.local`; the Codex checkout's `alias.txt` → `.env.local`; a deleted
  `.hidden-kept.png` whose store row and copy the fixture writes.
- image, 403: `.hidden.png`; `alias.png` → `.hidden.png`; `c1.png` → `c2.png`
  → `.hidden.png`; `.meta/shot.png`; `<evidence>/.cache-x/shot.png`; the
  deleted kept `.hidden-kept.png`.
- frame: report dir `alias.txt` → `.env.local` and `.meta/notes.txt` (403);
  meta read of `.meta/r2/index.html` (403, no `frame`).
- artifact and image also refuse a legacy retained visible alias to a hidden
  picture or folder after deleting only the alias, with the source still
  present; direct cache paths, cache aliases and removed checkouts are covered.
  `reportMedia/store.test.ts` verifies that a legacy row is certified only
  after a fresh copy, and that the certified picture survives source deletion.
- `reportMedia/store.test.ts`: `keepWrittenPictures` keeps nothing for
  `.hidden-kept.png`, `alias.png` → `.hidden.png`, or `<temp>/x/.cache/p.png`.
- Changed: `artifact/frame/[...rest]/route.test.ts:189` expects 403 for `.env`
  (was 415).

**Keep** (green on both, 200, same bytes):

- `shots/render.png` (image, artifact) and `reports/report.md` (artifact) under
  `.worktrees/wt-a`, `.claude/worktrees/wt-b` and `worktrees/wt-c`, only the
  parent registered; the same in a Codex checkout
  `<home>/.codex/worktrees/<hash>/<repo>` and a sibling
  `<home>/.agents/tools/<repo>-pipeline-x`, each its own root;
- `.artifacts/cap/frame.png` (image) and
  `.artifacts/pipeline-stage-inputs/private/previous-output.md` (artifact) in
  `<proj>` and in `.worktrees/wt-a`;
- state directory at `<home>/.config/agent-log-viewer/state`:
  `scratch/llv-stage-x/tmp/out/frame.png` and `…/tmp/.artifacts/cap/frame.png`
  (image), `…/tmp/report.md` (artifact), `evidence/<lane>/frame-01.png` (both),
  `evidence/attempt-temp/<key>/files/.artifacts/cap/frame.png` (image);
  `<evidence-root>/<lane>/after.png` (image);
- kept copies of deleted pictures: `.worktrees/wt-a/shots/gone.png` (both) and
  `<temp>/claude-<uid>/<encoded-cwd>/<session>/scratchpad/gone.png` (image);
- a report frame in `.worktrees/wt-a/reports/` serving `index.html` and
  `style.css`.

Verification on 2026-11-14: 134 tests in six explicit files pass, plus two
supplementary route probes consuming the real baseline writer's retained
visible-alias record. The 16 legacy-alias/cache regressions return 200 on
`6a8da56e` and 403 with the fix. All three route keep cases pass on both.
Typecheck and changed-file lint pass. Every invocation uses private HOME,
XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR and a closed control URL through
the recorded gate, with fixture files only.

## 9. Deferred — not currently justified

- A session run inside a home tool folder (a Codex or Claude home) makes that
  folder a root, and its non-hidden files with served extensions answer.
  Components above a root cannot be judged (real roots sit under hidden home
  folders); this is root admission.
- Hard links: making one needs write access, and Git cannot check one out.
- Serving committed hidden folders (`.github/`) needs a Git index read per
  request or a growing list.
- Unchanged: the keyless access model; the home-wide `admittedSource`
  (`prototypeReview/input.ts:63-75`), which copies into a fenced store and
  serves no path.

No performance gain is claimed. Hidden-component checks walk containing roots;
kept-copy provenance uses the existing bounded, stat-cached picture index.
