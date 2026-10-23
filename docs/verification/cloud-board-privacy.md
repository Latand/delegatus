# Cloud board and privacy verification

Fixes #2403.
Fixes #2261.

The first drafts came from Codex Cloud. The patches were assessed against the issue bodies and comments on 2026-10-23, from base adce5764927f7e838f20070cd2968128912e861c.

| Issue | Decision | Fix and revert check |
| --- | --- | --- |
| #2403 | Kept | Removed the unreachable SchemeBoard, its private closure, obsolete tests, density capture, scheme-session styles and native docs-artifact imports. Moved the unchanged SubagentTrayApi contract to src/components/scheme/subagentTray.ts:338 for its two live consumers. With the retirement detector retained and production changes reverted, the detector fails; restoring the fix passes. |
| #2392 | Dropped | scripts/capture-board-geometry.ts:1923 still awaits the retired band selector. The Cloud patch gives the same selector a constant and tests SchemeBoard, whose test is removed by #2403. Its post-removal apply check fails. Reworking the driver for KanbanBoard exceeds the permitted mechanical overlap resolution. The default capture remains unresolved; no fix or successful capture is claimed for this issue. |
| #2261 | Kept and strengthened | Removed the ambiguous global fingerprint. scripts/privacy-publication-gate.ts:1670 retains its digest in identity fields, account paths and handle mentions. Nine other catalog entries are unchanged. scripts/privacy-known-plaintext.test.ts:27 checks prose; :36 checks encoded identity contexts and similar safe labels; :56 checks real file and commit inspection. Restoring the old fingerprint fails the prose detector. Omitting the context rule fails both identity detectors. |

The #2403 Cloud patch also supplies the existing dark-theme group focus-ring mapping needed by the contrast suite. The contrast-test edits remove reads of the deleted pipeline strip. A resolver walk from 306 product entry files reached 2,327 local modules, no removed module and no unresolved local import. The optional saved checkout launcher is guarded by its existence check in bin/cli.mjs.

Open overlapping diffs were read for #3277, #3265, #3263, #3249, #3241, #3212 and #3253. Their independent changes were left alone. A final fetch confirmed origin/main still named the starting base.

All remote checks ran sequentially through gate-remote, whose gate-env isolates home, configuration, state and temporary directories. The privacy suite uses Bun 1.3.3 because its source-bound placeholder generator requires that version. Typecheck and production build use the installed runtime. No test preload or hook was disabled.

In the following commands, CLOUD names the supplied promotion-artifact directory under $HOME/.local/state/delegatus-promotion. FIXED_TESTS means the explicit list shown below.

| Command or control | Exit | Observation |
| --- | --- | --- |
| gh issue view 2403 --comments; repeated for 2392 and 2261 | 1 each | CLI queried the deprecated classic-project field. |
| gh issue view 2403 --comments --json number,title,body,comments; repeated for 2392 and 2261 | 0 each | Read each originating issue and all comments. |
| gh pr list --state open --limit 100 --json number,title,files; gh pr diff for each overlapping PR listed above | 0 each | Reviewed actual overlap before changing those files. |
| git apply --check "$CLOUD/cloud-2403.diff"; repeated for 2392 and 2261 before edits | 0 each | All original patches applied to the starting tree. |
| git apply "$CLOUD/cloud-2403.diff" | 0 | Applied first. |
| gate-remote -- bun test src/components/scheme/retiredSchemeBoard.test.ts src/styles/darkControls.contrast.test.ts | 0 | Initial patched tree: 21 pass. |
| git apply -R "$CLOUD/cloud-2403.diff" | 0 | Initial reverse also removed its new detector; that attempt was discarded as retirement-test evidence. |
| gate-remote -- bun test src/components/scheme/retiredSchemeBoard.test.ts src/styles/darkControls.contrast.test.ts on the first reversed tree | 1 | Only the contrast file ran: 19 pass, 1 fail. |
| Reapply; save both detector files; reverse again; restore both detector files | 0 for each git apply and copy | Prepared a valid control with the retirement detector still present. |
| gate-remote -- bun test src/components/scheme/retiredSchemeBoard.test.ts src/styles/darkControls.contrast.test.ts with production reverted and detectors retained | 1 | 19 pass, 2 fail, including the retirement detector. |
| git apply --exclude=src/components/scheme/retiredSchemeBoard.test.ts --exclude=src/styles/darkControls.contrast.test.ts "$CLOUD/cloud-2403.diff" | 0 | Restored production while preserving the detectors. |
| git apply --check "$CLOUD/cloud-2392.diff" after #2403 | 1 | The SchemeBoard band test no longer exists; patch dropped. |
| git apply "$CLOUD/cloud-2261.diff" | 0 | Applied the Cloud privacy draft, then added scoped identity protection and updated regeneration guidance. |
| gate-remote -- bun test scripts/privacy-known-plaintext.test.ts with catalog deletion alone | 1 | 4 pass, 2 fail: both new identity-protection detectors expose the Cloud draft's gap. |
| gate-remote -- bun test scripts/privacy-known-plaintext.test.ts after adding the context rule | 0 | 6 pass. |
| Restore the base catalog; gate-remote -- bun test scripts/privacy-known-plaintext.test.ts | 1 | 4 pass, 2 fail, including the prose regression. The fixed catalog was restored afterward. |
| gate-remote -- bun x bun@1.3.3 test FIXED_TESTS before OCR provisioning | 1 | 692 pass, 11 media-audit failures because tesseract was absent. |
| gate-remote -- bun x bun@1.3.3 test scripts/privacy-publication-gate.test.ts --test-name-pattern 'audits authenticated\|audits extensionless' | 1 | Both selected failures explicitly reported the missing executable. |
| Full base privacy suite from a git archive under the same remote isolation | 1 | Reproduced the 11 missing-OCR failures; five additional provenance cases failed because the archive lacked Git metadata. Replaced this baseline method with a detached scratch checkout. |
| apt-get download for the missing OCR dependency closure; dpkg-deb -x for each downloaded package; tesseract --list-langs | 0 each | Extracted 18 packages into one owned scratch root; eng, osd and ukr available. No system installation. |
| Paired remote recipe below: baseline full privacy suite | 0 | 642 pass, 0 fail. |
| Paired remote recipe below: candidate FIXED_TESTS | 0 | 703 pass, 0 fail. Both result records and the final run count were present. |
| gate-remote -- bunx tsc --noEmit after #2403 | 0 | Whole-project typecheck passed. |
| gate-remote -- bunx tsc --noEmit on the final source | 0 | Final whole-project typecheck passed. |
| gate-remote -- bun run build | 0 | Production Viewer, MCP and gate tooling built. Later source edits concern privacy scripts outside tsconfig.production.json's source graph. |
| bun scripts/eslint-changes.ts --base adce5764927f7e838f20070cd2968128912e861c SURVIVING_SOURCE_FILES | 0 | No introduced errors; 73 existing diagnostics in the touched dashboard/mobile files. |
| Plain git commit for #2403; plain git commit for #2261 | 0 each | Repository hooks ran staged whitespace, privacy and ESLint. |
| git commit --amend --no-edit when adding this verification record (first attempt) | 1 | Whitespace hook rejected an extra blank line at EOF; corrected before retry. |
| bun run privacy:check | 0 | Full changed-file and commit-message publication scan passed. |
| git diff adce5764 --check; git fetch --no-tags origin main; git status --short | 0 each | Whitespace clean; base unchanged; worktree clean. |

FIXED_TESTS is:

~~~text
scripts/privacy-publication-gate.test.ts
scripts/privacy-known-plaintext.test.ts
src/components/scheme/retiredSchemeBoard.test.ts
src/styles/darkControls.contrast.test.ts
src/components/scheme/subagentTray.test.ts
~~~

SURVIVING_SOURCE_FILES is:

~~~text
docs/design/task-board-integration/artifact/board.tsx
docs/design/task-board-integration/artifact/build-renderer.mjs
src/components/ProjectDashboard.tsx
src/components/mobile/MobileFocusView.tsx
src/components/scheme/retiredSchemeBoard.test.ts
src/components/scheme/subagentTray.ts
src/styles/darkControls.contrast.test.ts
scripts/privacy-known-plaintext.test.ts
scripts/privacy-publication-gate.ts
~~~

The paired check can be reproduced by passing the following recipe as the single shell argument to gate-remote -- bash -c. It preserves Git metadata for trusted-provenance checks and closes each test invocation's input:

~~~bash
set -euo pipefail
repo=$PWD
ocr=$(mktemp -d "$TMPDIR/privacy-ocr-XXXXXX")
mkdir "$ocr/packages" "$ocr/root"
cd "$ocr/packages"
python3 - <<'PY'
import subprocess,re,pathlib
roots=["tesseract-ocr","tesseract-ocr-eng","tesseract-ocr-ukr"]
output=subprocess.check_output(["apt-cache","depends","--recurse","--no-recommends","--no-suggests","--no-conflicts","--no-breaks","--no-replaces","--no-enhances",*roots],text=True)
packages=sorted({s for s in output.splitlines() if re.fullmatch(r"[a-z0-9][a-z0-9+:.~-]*",s)})
missing=[]
for name in packages:
    status=subprocess.run(["dpkg-query","-W","-f="+chr(36)+"{Status}",name],text=True,capture_output=True)
    if status.returncode or status.stdout!="install ok installed":missing.append(name)
print("OCR scratch dependencies:",len(missing),flush=True)
subprocess.run(["apt-get","download",*missing],check=True)
for package in sorted(pathlib.Path(".").glob("*.deb")):
    subprocess.run(["dpkg-deb","-x",str(package),"../root"],check=True)
PY
export PATH="$ocr/root/usr/bin:$PATH"
export LD_LIBRARY_PATH="$ocr/root/usr/lib/x86_64-linux-gnu:$ocr/root/lib/x86_64-linux-gnu"
export TESSDATA_PREFIX="$ocr/root/usr/share/tesseract-ocr/5/tessdata"
tesseract --list-langs
cd "$repo"
baseline=$(mktemp -d "$TMPDIR/privacy-baseline-XXXXXX")
git clone --quiet --shared --no-checkout "$repo" "$baseline"
git -C "$baseline" checkout --quiet --detach adce5764927f7e838f20070cd2968128912e861c
ln -s "$repo/node_modules" "$baseline/node_modules"
set +e
(cd "$baseline"; setsid bun x bun@1.3.3 test scripts/privacy-publication-gate.test.ts 0<&-)
base_status=$?
printf 'BASE_PRIVACY_RESULT %s\n' "$base_status"
setsid bun x bun@1.3.3 test scripts/privacy-publication-gate.test.ts scripts/privacy-known-plaintext.test.ts src/components/scheme/retiredSchemeBoard.test.ts src/styles/darkControls.contrast.test.ts src/components/scheme/subagentTray.test.ts 0<&-
head_status=$?
printf 'HEAD_PRIVACY_RESULT %s\nPRIVACY_RUNS 2\n' "$head_status"
test "$base_status" -eq 0 && test "$head_status" -eq 0
~~~

The final diff was self-reviewed. There is one commit for each kept issue, with machine attribution retained. No revert was committed, no push was made, no issue comment was posted and no workflow file was edited.
