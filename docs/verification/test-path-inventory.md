# Test-file inventory

Inventory of all **1520 tracked test files** at `origin/main` = `1d0eda9302bfa5c1df7e392f6002091ab0c7c7e9` (the fetched start point).

Baseline: 1,333 pass, 167 fail, 3 timeout, 17 gated/skipped. Latest per-file results: **1435 pass, 65 fail, 2 timeout, 18 gated/skipped**; **102 baseline failures now pass**. Remaining failures are assigned below to fenced lanes or explicit decisions; this does not claim all main tests are green.

Each executed file ran sequentially in its own process, with unique isolated state/HOME/config and short temporary paths, under the heavy-check flock and an 8 GiB systemd scope. Baseline timeout: 120s; targeted reruns: 300s. Bun 1.4.0; the Python test used Python 3. No live registry or unowned process was stopped. Browser opt-ins and credential prerequisites were not enabled. The C54 rerun supplied compiled CSS and an installed Chromium cache in a disposable source export, exercising both themes without changing committed captures. Tests containing partial skips still count as pass only when their process exited successfully.

P=pass; F=fail; T=timeout; G=gated or prerequisite-skipped (not a Linux exclusion); no entire file was Linux-only skipped. `B→F` means baseline→latest; a single status is unchanged. Causes: B=code bug, S=stale test, M=machine-dependent default/budget, L=state/cache leak, E=environment. L includes within-file singleton leaks exposed by fresh-process execution.

Decisions retained: recapture or retire historical screenshot evidence; reconcile uncertain-delivery expectations in their owning lanes; profile or recalibrate the link-sync CPU budget. Thresholds and pinned captures were preserved. Authenticated pipeline coverage remains gated without an isolated credential.

## Repeating the inventory

Prerequisites: Linux with a working user systemd manager, `flock`, GNU `timeout`, Python 3, Node (including `node` on PATH), Git and Bun **1.4.0**. Run from a clean checkout of the revision to verify. Use the pinned baseline below and pin the candidate with `git rev-parse HEAD`; a moving `origin/main` changes the experiment. The recipe uses disposable clones because evidence tests can rewrite files. Dependencies are installed from each revision's lockfile. Baseline intentionally has no production build; missing CSS/build prerequisites therefore remain baseline failures.

Copy this runner into fresh scratch storage. It uses the original tracked-path selection and environment allowlist. Each invocation runs one phase sequentially; each file gets a new short `/tmp/iv-*` sandbox. No operator HOME, owner token, structured-host link, credentials, browser opt-in or other `LLV_*` setting passes through. Logs and PID receipts stay local.

```bash
export INVENTORY_OUT=$(mktemp -d /var/tmp/test-inventory.XXXXXX)
export INVENTORY_BUN=$(command -v bun)
export INVENTORY_NODE=$(command -v node)
cat > "$INVENTORY_OUT/run.py" <<'PY'
import json, os, pathlib, re, shutil, subprocess, sys, tempfile, time

repo = pathlib.Path.cwd()
out = pathlib.Path(os.environ["INVENTORY_OUT"])
phase = os.environ.get("INVENTORY_PHASE", "baseline")
tracked = subprocess.check_output(["git", "ls-files"], text=True).splitlines()
files = sys.argv[1:] or sorted(p for p in tracked if
    re.search(r"[.](test|spec)[.](tsx?|[cm]?jsx?)$", p) or
    re.search(r"(^|/)test_[^/]+[.]py$", p))
assert len(files) == len(set(files)) and all(p in tracked for p in files)
logs = out / phase
logs.mkdir()  # A new phase refuses to overwrite previous evidence.
(out / (phase + "-manifest.json")).write_text(json.dumps(files, indent=2) + "\n")
(logs / "revision.txt").write_text(subprocess.check_output(
    ["git", "rev-parse", "HEAD"], text=True))
for index, file in enumerate(files):
    row = {"file": file}
    source = (repo / file).read_text()
    if "LLV_KANBAN_BROWSER_TEST" in source or "LLV_SWIPE_BROWSER_TEST" in source:
        row.update(status="gated", reason="explicit browser opt-in remains disabled")
    else:
        with tempfile.TemporaryDirectory(prefix="iv-", dir="/tmp") as directory:
            root = pathlib.Path(directory)
            for folder in ["s", "h", "c", "t", "d", "cache"]:
                (root / folder).mkdir()
            env = {k: v for k, v in os.environ.items() if k in [
                "PATH", "LANG", "LC_ALL", "TERM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL",
                "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]}
            env.update(HOME=str(root / "h"), XDG_CONFIG_HOME=str(root / "c"),
                XDG_DATA_HOME=str(root / "d"), XDG_CACHE_HOME=str(root / "cache"),
                LLV_STATE_DIR=str(root / "s"), TMPDIR=str(root / "t"),
                NODE_ENV="test", CI="1")
            if os.environ.get("INVENTORY_NODE_QUOTING") == "1":
                alias = root / "node'$fixture"
                alias.symlink_to(os.environ["INVENTORY_NODE"])
                env["LLV_TEST_NODE_BIN"] = str(alias)
            if os.environ.get("INVENTORY_BROWSER_CACHE"):
                env["PLAYWRIGHT_BROWSERS_PATH"] = os.environ["INVENTORY_BROWSER_CACHE"]
            command = ["python3", file] if file.endswith(".py") else [
                os.environ["INVENTORY_BUN"], "test", "./" + file]
            start = time.monotonic()
            logfile = logs / (str(index) + ".log")
            with logfile.open("w") as log:
                child = subprocess.Popen(["timeout", "--kill-after=5s",
                    os.environ.get("INVENTORY_TIMEOUT", "120s"), *command],
                    env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                with (out / "pids.jsonl").open("a") as receipts:
                    receipts.write(json.dumps({"pid": child.pid, "file": file,
                        "phase": phase, "sandbox": directory}) + "\n")
                code = child.wait()
            content = logfile.read_text(errors="replace")
            counts = {k: int(v) for v, k in re.findall(
                r"^\s*(\d+) (pass|fail|skip|todo)\s*$", content, re.M)}
            status = "timeout" if code in [124, 137] else "pass" if code == 0 else "fail"
            if code == 0 and counts.get("pass", 0) == 0 and counts.get("skip", 0) > 0:
                status = "prerequisite-skipped"
            row.update(status=status, code=code, counts=counts,
                seconds=round(time.monotonic() - start, 2), log=logfile.name)
    with (out / (phase + ".jsonl")).open("a") as stream:
        stream.write(json.dumps(row) + "\n")
    print(json.dumps(row), flush=True)
PY
```

Create baseline and candidate clones, install dependencies, then run the baseline with a 120s **process** timeout per path (Bun's own test-case timeouts also apply). The lock surrounds the entire sequential runner and the 8 GiB scope covers its children. An unavailable user systemd manager or dependency install is a prerequisite failure; do not silently drop the scope or lock.

```bash
export INVENTORY_BASE=1d0eda9302bfa5c1df7e392f6002091ab0c7c7e9
export INVENTORY_HEAD=$(git rev-parse HEAD)
for spec in "baseline:$INVENTORY_BASE" "candidate:$INVENTORY_HEAD"; do
  folder=${spec%%:*}
  revision=${spec#*:}
  git clone --shared --no-checkout . "$INVENTORY_OUT/$folder-source"
  git -C "$INVENTORY_OUT/$folder-source" checkout --detach "$revision"
  (cd "$INVENTORY_OUT/$folder-source" && "$INVENTORY_BUN" install --frozen-lockfile)
done
(cd "$INVENTORY_OUT/baseline-source" &&
  INVENTORY_PHASE=baseline INVENTORY_TIMEOUT=120s \
  flock /var/tmp/llv-heavy-gate.lock \
  systemd-run --user --scope -p MemoryMax=8G python3 "$INVENTORY_OUT/run.py")
```

For targeted reruns, select exact baseline paths with a changed result in this table, plus every changed executable test. This is a reproducible replacement for the historical scratch selection manifests. Supply a 300s timeout. Run individual additional paths by replacing the argument list with the desired repo-relative path. Each new rerun must have a distinct phase name.

```bash
mapfile -t reruns < <(python3 - <<'PY'
import os, pathlib, re, subprocess
text = pathlib.Path("docs/verification/test-path-inventory.md").read_text()
paths = {p for p, before, after in re.findall(
    r"^\| `([^`]+)` \| ([PFTG]) \| ([PFTG]) \|", text, re.M) if before != after}
changed = subprocess.check_output(["git", "diff", "--name-only",
    os.environ["INVENTORY_BASE"], os.environ["INVENTORY_HEAD"]], text=True).splitlines()
paths.update(p for p in changed if re.search(r"[.](test|spec)[.](tsx?|[cm]?jsx?)$", p))
print("\n".join(sorted(paths)))
PY
)
(cd "$INVENTORY_OUT/candidate-source" &&
  INVENTORY_PHASE=rerun INVENTORY_TIMEOUT=300s \
  flock /var/tmp/llv-heavy-gate.lock \
  systemd-run --user --scope -p MemoryMax=8G \
  python3 "$INVENTORY_OUT/run.py" "${reruns[@]}")
```

Browser prerequisites: the ungated C54 suite needs `.next/static/css/*.css` from `bun run build` (the package selects webpack) and Playwright Chromium matching the pinned `playwright-core`. Build and install the browser in scratch, then rerun C54:

```bash
build_root=$(mktemp -d /tmp/iv-build.XXXXXX)
mkdir "$build_root"/{h,c,s,t}
(cd "$INVENTORY_OUT/candidate-source" &&
  flock /var/tmp/llv-heavy-gate.lock \
  systemd-run --user --scope -p MemoryMax=8G \
  timeout --kill-after=5s 900s env -i PATH="$PATH" \
  HOME="$build_root/h" XDG_CONFIG_HOME="$build_root/c" \
  LLV_STATE_DIR="$build_root/s" TMPDIR="$build_root/t" \
  NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=6144 \
  "$INVENTORY_BUN" run build)
(cd "$INVENTORY_OUT/candidate-source" &&
  PLAYWRIGHT_BROWSERS_PATH="$INVENTORY_OUT/browsers" \
  "$INVENTORY_BUN" node_modules/playwright-core/cli.js install chromium)
(cd "$INVENTORY_OUT/candidate-source" &&
  INVENTORY_PHASE=browser INVENTORY_TIMEOUT=300s \
  INVENTORY_BROWSER_CACHE="$INVENTORY_OUT/browsers" \
  flock /var/tmp/llv-heavy-gate.lock \
  systemd-run --user --scope -p MemoryMax=8G \
  python3 "$INVENTORY_OUT/run.py" src/components/mobile/issue1347Evidence.browser.test.tsx)
```

Require a successful build and browser installation before the last command. Its existing test checks light and dark; generated captures stay in the disposable clone. Leave `LLV_KANBAN_BROWSER_TEST` and `LLV_SWIPE_BROWSER_TEST` unset. Authenticated integration requires a separately provisioned isolated credential; this recipe supplies none.

Aggregation: exit 0 with at least one passing case is P, nonzero is F, 124/137 is T. Explicit opt-in files and zero-pass/all-skip successful processes are G; inspect their skip guards before distinguishing a Linux exclusion from an unmet prerequisite. In this inventory every such skip is a prerequisite. Partial skips with exit 0 remain P. Python exit 0 is P even without Bun counts. Causes require reading the corresponding log; a failed build/browser prerequisite must not be reported as a passing browser check.

The historical result order was `baseline`, `fixed`, `fixed2`, `fixed3`, `fixed4`, `fixed5`, `quoted`, `final`, `final2`, `final3`, followed by this review's C54 rerun and the `bounded-diagnostics` fix-round rerun below. `quoted` enabled `INVENTORY_NODE_QUOTING=1` for the resource/extraction shell-path regressions. For a fresh reproduction, use `baseline`, `rerun`, then `browser`. Fold in that explicit order, replacing only existing baseline keys; an absent rerun retains its baseline result. Never sum process counts across phases. This copyable fold prints the exact per-path table and totals:

```bash
python3 - baseline rerun browser <<'PY'
import collections, json, os, pathlib, sys
out = pathlib.Path(os.environ["INVENTORY_OUT"])
base = {r["file"]: r for r in map(json.loads, (out / "baseline.jsonl").read_text().splitlines())}
latest = dict(base)
for phase in sys.argv[1:]:
    source = out / (phase + ".jsonl")
    if source.exists():
        for row in map(json.loads, source.read_text().splitlines()):
            if row["file"] in base:
                latest[row["file"]] = row
codes = {"pass": "P", "fail": "F", "timeout": "T", "gated": "G", "prerequisite-skipped": "G"}
for file in sorted(base):
    print(f'| `{file}` | {codes[base[file]["status"]]} | {codes[latest[file]["status"]]} |')
print(dict(collections.Counter(codes[r["status"]] for r in latest.values())))
print("repaired:", sum(base[p]["status"] in ["fail", "timeout"] and
    latest[p]["status"] == "pass" for p in base))
PY
```

Recipe verification used the copied runner under the documented lock/scope: `AccountBadge.render.test.tsx` passed 4 cases; the old C54 selector failed at the unchanged geometry assertion (114px versus -1), then the corrected file passed the full light/dark test (first card bottom 276px). `kanbanBoard.browser.test.tsx` was gated before launch; `pipelineStageHostAccess.integration.test.ts` exited 0 with one prerequisite skip. Folding these actual records produced two P and two G with one repaired failure. Both changed executable files passed lint, and the full fingerprint-aware, commit-aware local privacy gate passed. Committed captures and fenced files remain unchanged.

The diagnostics fix-round rerun copied the same runner and invoked only `src/lib/agent/registry.sqlite.test.ts`, with `INVENTORY_PHASE=bounded-diagnostics` and `INVENTORY_TIMEOUT=300s` under the documented flock and 8 GiB scope. The whole file exited 0: **68 pass, 0 fail, 369 assertions, 30.63s process time**. The prior growing-spawn fixture exceeded its 60s test-case deadline in independent full-file runs (64.4–85.0s). Replacing it with 650 real `setEngineRouting` writes keeps the registry size bounded while preserving all four backend modes, the injected clock and every metric assertion. Diagnostics now pass in 0.80s (`off`), 1.64s (`dual-write`), 0.56s (`read`) and 0.56s (`sqlite`), with the original **30s** test-case deadline restored. This fixes the test fixture; production storage code is unchanged. The file's latest P result is now confirmed by this full-file run; inventory totals remain unchanged.

The dropped-evidence-note review finding came from constructing its 205-row history through **410 SQLite mutations inside the 5s test case**; two isolated full-file reruns measured 5.908s and 5.382s. The setup now creates the rows in three JSON partitions below each partition's retention bounds, moves the durable rows to one conversation, imports them into SQLite, then uses a real SQLite delivery pair to trigger compaction. The original admission checks, uncertain-delivery retry, compaction note persistence, close/reopen restart, retained-key check, and unchanged 5s deadline remain. Five consecutive full-file runs used unique `LLV_STATE_DIR`, `HOME`, and `TMPDIR`, each under the documented lock and 8 GiB scope with a 300s process timeout: **68 pass / 0 fail and 369 assertions each**, in 25.88s, 23.58s, 24.73s, 23.84s, and 21.79s. The target case took 1.41s, 0.82s, 0.98s, 0.90s, and 1.11s. A second five-run series on the merged head also passed 68/0 each; target case times were 0.918s, 0.805s, 0.742s, 0.749s, and 0.670s. This fixes test setup cost; production compaction code is unchanged.

## Ownership

O1: owned by lane d713000d (PR #2474) / lane 909814bf (PR #2430).
O2: owned by lane 501e3cb2 (PR #2473).
O3: owned by lane aeeb3bc4 (PR #2479).
O4: owned by lane aeeb3bc4 (PR #2464) / lane aeeb3bc4 (PR #2479).
O5: owned by lane for PR #2402.
O6: owned by lane 32fbb1d3 (PR #2481) / lane for PR #2472.
O7: owned by lane for PR #2472 / lane 32fbb1d3 (PR #2481).
O8: owned by lane for PR #2447.
O9: owned by lane 402ea294 (PR #2448).
O10: owned by lane 909814bf (PR #2430) / lane for PR #2402.
O11: owned by lane for PR #2472.
O12: owned by lane for PR #2419.
O13: owned by lane for PR #2466.
O14: owned by lane 909814bf (PR #2430).
O15: owned by lane for PR #2469.
O16: owned by lane 160bea11 (PR #2485).
O17: owned by lane 7f7419b2 (PR #2486).
O18: owned by lane 36364a1f (PR #2480).
O19: owned by lane 909814bf (PR #2430) / lane 849dbe3d (PR #2458) / lane 7ab0ea83 (PR #2484).
O20: owned by lane 909814bf (PR #2430) / lane for PR #2446.
O21: owned by lane 909814bf (PR #2430) / lane 849dbe3d (PR #2458).
O22: owned by lane for PR #2470.
O23: owned by lane 909814bf (PR #2430) / lane d713000d (PR #2474).

## Causes and evidence

| Cause | Type | Evidence | Owner |
| --- | --- | --- | --- |
| C1 | S | Checkout CLI fixture omits newly imported oomPolicy.mjs; fixture dependency copy repaired startup. | — |
| C2 | S | Self-update fixtures time out after restart/admission authentication changed; dedicated launcher-authentication fix owns the seam. | O1 |
| C3 | S | Entrypoint copy fixture omits self-update-supervisor.mjs; child exits during module loading. | — |
| C4 | S | Pinned screenshot manifest hashes and deterministic regeneration disagree with current harness; recapture versus retirement requires decision, artifacts must stay unchanged. | — |
| C5 | E | Real Bun audit endpoint exercise fails retry HTTP protocol; dedicated relay recovery change adds matching runtime behavior. | O2 |
| C6 | S | Packed-bin smoke assertions lag the package launcher surface; dedicated relay recovery lane changes this exact fixture. | O2 |
| C7 | S | YAML parser produces on rather than boolean true key; workflow.true.push fixture dereference fails. | O3 |
| C8 | S | Trusted source-bound media fixtures no longer regenerate expected assets; dedicated privacy matrix work owns generator and tests. | O4 |
| C9 | S | Publish workflow now prefixes test paths with ./; exact command-string expectation is outdated. | O2 |
| C10 | L | Process-wide registry or legacy-store cache survives deletion/replacement of test state root; close/reset before sandbox removal. This is within-file state leakage, not a proven cross-test-file collision. | — |
| C11 | B | Repeated account migration omits archived generation paths from placement cleanup; current coordinator diff includes archivedGenerationPaths, with separate retained-hidden-path fixture drift. | — |
| C12 | S | Scan cache schema is 12; fixture assertion still expected 11. | — |
| C13 | M | Live free-space telemetry changes files-response ETag between identical projections; inject a fixed storage probe. | — |
| C14 | S | Uninitialized attention collection changes first-read revision; old cache-schema and report fixture fields also drifted. | — |
| C15 | B | Second-pass service-tier derivation rereads tails after 64-entry shared cache eviction; 65 transcripts cost 130 reads. Also contains schema-11 fixtures and registry cleanup leakage. | — |
| C16 | S | Shipped builder preset now uses current Sol model and high effort; fixture retained retired model/medium effort expectations. | — |
| C17 | S | Role catalog now includes maintainer; fixed cardinality and role-list fixture lag current shipped presets. | — |
| C18 | S | Settlement deliberately rechecks after refused transition to observe racing delivery; fixture expected only one journal read. | — |
| C19 | S | Silent-root spawn fixture omitted required clientAttemptId; response-status assertion concealed validation refusal. | — |
| C20 | S | Fresh-install configuration path is delegatus; fixture still reads the legacy agent-log-viewer directory. | — |
| C21 | E | Required production build is absent, causing explicit build precondition failure and cascading empty startup/fetch evidence; served-payload suite passes after the isolated production build. | — |
| C22 | S | Server-rendered account Hint is closed; fixture expects hidden tooltip content instead of accessible chip identity. | — |
| C23 | S | DOM fixture does not install requestAnimationFrame/cancelAnimationFrame used by production components; browser lifecycle cannot mount normally. | — |
| C24 | B | SpeakButton.tsx:137 reads snapshot!.phase while its SSR snapshot is null; reproduced TypeError across all four server-render suites. | O2 |
| C25 | S | DOM fixture does not install requestAnimationFrame/cancelAnimationFrame used by production components; browser lifecycle cannot mount normally. | O5 |
| C26 | S | Uncertainty queue expectations conflict with deliberate local-wire release in outbox.ts:2170; automatic receipt GETs also require fixture updates. | O6 |
| C27 | S | DOM fixture does not install requestAnimationFrame/cancelAnimationFrame used by production components; browser lifecycle cannot mount normally. | O2 |
| C28 | S | Completed task fixtures lack a current doneAt and expire under three-day board retention, removing expected cards and readers. | — |
| C29 | S | Parentless background tasks remain discoverable through project model but no longer have the retired board dock markup. | — |
| C30 | S | Mock links/shared endpoint omits known array; view.known.some fails before intended UI assertions. Header/menu lists also changed. | — |
| C31 | S | Settled-worker folding removes unpinned conversation; fixture needs explicit manual board placement to test failed-launch hiding independently. | — |
| C32 | S | Account choice displays account label; assertion still expects internal account identifier. | — |
| C33 | S | Structured runtime selection is restored when reconfigure is pending; persisted fixture omits the pending phase. | — |
| C34 | S | Rendered text now names Delegatus; assertions retained Viewer wording and old spawn fixture contract. | O2 |
| C35 | S | Refresh/focus fixture retains retired model display and incomplete mount state; baseline null textarea and model mismatch require updated fixture before product attribution. | O5 |
| C36 | S | Fixture omits current persistence/session context; isolated corrected probe still fails receipt/remount dispatch assertions in the composer/outbox contract. | O7 |
| C37 | S | Model picker now renders through document portal; fixture queries only component host. | — |
| C38 | S | Overview attention sheet groups by project; fixture taps first row rather than intended conversation. Select the intended conversation row by its identity. | — |
| C39 | B | Fresh remoteAgents arrays in KanbanBoard.tsx:3032 defeat card memoization; catalog count also includes three presence HEADs. | O8 |
| C40 | S | Files request now uses view=summary; exact URL fixture omits the supported query parameter. | O9 |
| C41 | S | Model label is capitalized and versioned; lowercase substring expectation is outdated. | O10 |
| C42 | S | Bounded public runtime snapshot omits completed liveTurn; durable journal retains handoff evidence and is the appropriate assertion seam. | — |
| C43 | S | Runtime fixture omits sessionKey needed for transcript/runtime identity matching; stale overlay assertions receive no matching session. | — |
| C44 | S | Relay fixture expected retired model/default target shape; exact expectations repaired in relay lane. | O2 |
| C45 | S | Rendered reviewer role label is capitalized; fixture expects lowercase text. | O2 |
| C46 | B | Baseline lacks RAF; adding RAF exposes conditional useSeatProjectFor hook ordering in TmuxComposer after early returns; local RAF changes reverted. | O11 |
| C47 | S | Reconfigure receipt names stage Verify; old assertion expects Verifier. | — |
| C48 | S | Completed task fixtures lack a current doneAt and expire under three-day board retention, removing expected cards and readers. | O12 |
| C49 | S | Failed launch exposes bounded Launch failed explanation instead of retired raw error text. | O13 |
| C50 | S | Exhausted review edge completes final fix then advances; old tooltip expectation describes another failure. | — |
| C51 | B | AttentionPanel.tsx uses raw z-50 outside the shared layer scale; baseline names exact production source. | O14 |
| C52 | S | Composer height is adaptive; retired fixed 160px expectation receives 143px under phone chrome. | O15 |
| C53 | S | Review deck tap target uses inline height rather than retired h-12 class; assert actual minimum target size. | — |
| C54 | S | Baseline lacks compiled CSS; supplying it exposes the stale data-mobile2-row selector (firstRowBottom=-1). Use the current data-phone-card-kind conversation card; full light/dark browser rerun passes in scratch with unchanged geometry assertions and committed captures. | — |
| C55 | S | Mobile header fixture waits for retired shelf control removed by current phone menu design. | O15 |
| C56 | S | DOM fixture does not install requestAnimationFrame/cancelAnimationFrame used by production components; browser lifecycle cannot mount normally. | O12 |
| C57 | S | Seat attention lifecycle projection changed; exact seatState contract/test is active in task-motion work. | O12 |
| C58 | S | Runtime summary presents model and effort directly; old generic reasoning text assertion no longer matches. | — |
| C59 | S | Paused pipeline indicator is neutral; old render assertion requires warning color. | — |
| C60 | S | Archive deliberately retains predecessor and successor concrete hidden paths; fixture expected only successor. | — |
| C61 | S | Lineage fixture must open the ancestry fold and await selection; ResizeObserver must provide its observed entry. Targeted rerun passes. | — |
| C62 | S | Pipeline attempt fixtures omit effectiveRole; supply complete roles and assert current stage-row geometry. | — |
| C63 | S | Attempts omit effectiveRole; camera fixtures assume retired Fit behavior and first-arrow selection; supply roles and verify region-to-card navigation. | — |
| C64 | S | Direct-review stack composition fixture omits current membership/exclusion context; old zero-stack assumption no longer matches grouping. | — |
| C65 | S | Ancestor elision fixture lacks explicit collapsed-path context; current grouping retains the quiet ancestor without that input. | — |
| C66 | S | Anchored production feed fixture expects retired mounting behavior; ownership-history rendering seam is fenced. | O9 |
| C67 | S | Task/lane attachment menu assertions lag current action shape; current diff refreshes fixture expectations. | — |
| C68 | S | Startup diagnostics add hostKey and message to exact log objects; retry behavior itself succeeds. | O14 |
| C69 | M | File creation mode is filtered by process umask, invalidating unsafe-permissions setup; fixture must explicitly chmod. | — |
| C70 | S | Provider header isolation fixture expects retired routing/header shape; exact test repaired by relay lane. | O2 |
| C71 | L | Interprocess account fixture seeds/readbacks legacy JSON while SQLite state persists, causing missing controller update; reset both storage backends. | — |
| C72 | M | CLI presence expectation assumes machine default executable availability; active identity guard work owns exact fixture. | O16 |
| C73 | S | New spawn admission requires title; legacy launchProfile fixture omits it. | — |
| C74 | S | Retained recipient evidence contradicted the old payload-free assertion; the diagnostics fixture grew its registry across 650 spawns; and the dropped-evidence case built 205 rows through 410 SQLite mutations, exceeding 5s. Keep the original assertions and deadlines, bound diagnostics writes, and seed the SQLite history before triggering real compaction; five full-file runs pass 68/0. | — |
| C75 | M | Pipeline admission now requires a signed-in account; fixture relied on machine credentials instead of isolated fake auth evidence. | — |
| C76 | S | Child JSON result channel is contaminated by state-recovery diagnostics; redirect fixture diagnostics to stderr. | — |
| C77 | M | CPU budget exceeded twice (1000 calls: 2335/3230 ms >2000 ms); warmed heap rerun passes; file exceeds both 120s and 300s caps. Budget/profiling decision remains. | — |
| C78 | S | Fixed September 28 completion timestamps expire three-day board retention; fill loop creates extra task (306 versus 305). | — |
| C79 | S | Three injected pipeline records omit project; decision authorization canonicalizes undefined project and fails before intended receipt assertions. | O14 |
| C80 | S | Five-millisecond real deadline expires during preliminary registry lookup before targeted reader; synchronize deadline with intended partial-read phase. | — |
| C81 | S | Termination fixture omitted bootEpoch; complete captured identity makes both real MCP kill/interrupt paths pass. | — |
| C82 | S | Registry fixture supplies aliases instead of conversationAliases; pre-dismiss authority lookup dereferences missing field. | — |
| C83 | S | Verified live idle host projects waiting/host_alive_turn_idle; obsolete stalled expectation blocks subsequent maintainer refusal assertion. | — |
| C84 | S | Injected registry omits lineageEdges/memberships and later queried maps; use complete normalized registry fixture. | — |
| C85 | S | Optional deployment_status schema legitimately omits required; fixture calls array matcher on undefined. | O2 |
| C86 | S | Compact resources response omits detailed session rows; fixture must explicitly request full response. | O2 |
| C87 | S | Injected retry-stage engine dependencies omit callerAttribution/attentionAuthority; pre-mutation authority gate fails. | — |
| C88 | S | Explicit transcript lookup fixture lacks current full response option/shape; exact test repaired by relay lane. | O2 |
| C89 | M | Pipeline transition fixture lacks isolated authenticated Claude account; double-consumed stderr initially concealed child refusal. | — |
| C90 | B | Late-delivery evidence and controller wake wording diverge from expected reconciliation; dedicated seat wake audit changes exact source. | O17 |
| C91 | B | Delivered handoff directive exceeds its 13500-byte budget by 42 bytes; owned mandate budget repair. | O18 |
| C92 | B | Engine consumes recorded stage report before clearing orphan backgroundWait, retaining completed task state. | O19 |
| C93 | S | Legacy review fixture assumes old default round limit and publication policy; current default is three and internal policy must be explicit. | — |
| C94 | S | After supplying full child identity, kill settles but current pipeline recovery keeps the lane running instead of parking; engine recovery contract requires reconciliation. | O20 |
| C95 | S | Stage completion relay message envelope changed; exact old prompt payload assertion conflicts with current fenced handoff format. | O18 |
| C96 | B | Dead stage-host survivor retention and malformed row-key recovery affect generation closure; authenticated controller also refuses incomplete fixture calls. | O21 |
| C97 | S | Stage input provenance digest changes with adopted stage-created branch contract; exact test is edited by branch settlement PR. | O22 |
| C98 | S | Remote-publication default enters committing before advancing; fixture must explicitly choose intended internal or remote policy. | — |
| C99 | S | New spawn admission requires title; legacy launchProfile fixture omits it. | O2 |
| C100 | E | Hardcoded Node location is unavailable while PATH Node exists; worker fixture and escaped-descendant checks cannot launch intended interpreter. | — |
| C101 | B | Archive relay projection imports runtime/stateful author resolution; current diff injects live provenance and keeps archive projection pure. Also hardcoded Node path was absent. | — |
| C102 | B | Archive relay provenance depends on live project resolution, losing or fabricating sender project; current pure archive projection uses persisted provenance. | — |
| C103 | S | Deployment list and keyed latest lookup both order by deployment start; old tail assertion assumes lexical identifier order. | — |
| C104 | S | Recovery fixture omits spawn title and keyed readSession, and expects unbound MCP client key rather than persisted downstream key. | — |
| C105 | E | Authenticated integration explicitly requires isolated ChatGPT credential; absent credential is an unmet opt-in integration prerequisite. | — |
| C106 | S | Process ownership fixture omits bootEpoch/full captured identity required by termination fences; captureProcessIdentity supplies real owned-child identity. | — |
| C107 | S | Partial-adoption fixture retains its host but held send stays delivery-uncertain with zero engine writes; recovery-origin assertion also omits project. Startup/queue contract remains owned. | O14 |
| C108 | S | Account-switch fake runtime lacks keyed readSession contract; full snapshot stub no longer serves production lookup. | — |
| C109 | S | Delivery/rebind termination fixtures lack valid owned host process identity; capture owned fixture child to exercise current safety fence. | — |
| C110 | S | Account mutation busy error now reports cross-process lease identity; fixture expected obsolete in-process wording. | O2 |
| C111 | S | Corruption fixture attempts invalid JSON insertion under JSON-expression indexes; remove indexes only in isolated corruption fixture before keyed-reader assertion. | — |
| C112 | B | Keyed HTTP admission scans nextAdmissionSeq/beginDeliveryAttempt registry rows; 242380 rows versus bound below 12000. | O14 |
| C113 | M | Launch profile inherits current service-tier default; fixture needs explicit null to test switch rollback independently. | — |
| C114 | L | Registry singleton survives removed scan sandbox; secondary project expectation uses retired display key instead of canonical project identity. | — |
| C115 | M | Live freeBytes changes response ETag/delta during worker reuse tests; stabilize storage observation while preserving worker lifecycle assertions. | O2 |
| C116 | M | Project identity fixture assumes historical checkout path and remote; create isolated repository/worktree metadata instead. | — |
| C117 | S | Stores preserve malformed records outside executable snapshots, while corrupt archive JSON throws; old all-malformed-throws and empty-archive assertions conflict. | — |
| C118 | S | Task route imports operatorAuthority, violating the test broad agent-module import boundary; route auth contract needs lane reconciliation. | O12 |
| C119 | M | Unsafe-permissions fixture is masked by current umask; chmod explicitly after creation. | — |
| C120 | S | Report runner now uses current Sol preset; fixture expects retired Astra default. | O2 |
| C121 | M | Isolated process has no runtime socket, so transport defaults to tmux and drops Telegram; fixture must explicitly supply sandbox structured transport and connected session. | — |
| C122 | S | net.Server.close may already unlink socket path; fixture must tolerate ENOENT before successor bind. | — |
| C123 | B | Candidate parser rejects Compose-normalized bind.create_host_path; preserve explicit autocreate semantics in Docker arguments. | — |
| C124 | E | Hardcoded Node path fails first; corrected Node exposes managed probe authentication/fallback timeout in active self-update admission work. | O23 |

## Full inventory

| Repository-relative test file | Baseline | Latest | Cause |
| --- | --- | --- | --- |
| `bin/agent-binaries.test.ts` | P | P | — |
| `bin/bind-guard.test.ts` | P | P | — |
| `bin/cli.exposure.integration.test.ts` | F | P | C1 |
| `bin/cli.selfUpdate.integration.test.ts` | T | T | C2 |
| `bin/envAlias.test.ts` | F | P | C3 |
| `bin/legacySystemd.test.ts` | P | P | — |
| `bin/mcp-server.test.ts` | P | P | — |
| `bin/oomPolicy.test.ts` | P | P | — |
| `bin/self-update-supervisor.test.ts` | P | P | — |
| `bin/server-runtime.test.ts` | P | P | — |
| `bin/skillLinks.test.ts` | P | P | — |
| `docs/design/codex-api-update/test_probe_evidence.py` | P | P | — |
| `docs/design/task-workflow-model/extract.test.mjs` | P | P | — |
| `docs/media/issue-626/evidence.test.ts` | P | P | — |
| `docs/screenshots/issue-499/deepen-to-evidence-revision.test.ts` | P | P | — |
| `docs/screenshots/issue-499/depth-one-evidence.test.ts` | F | F | C4 |
| `docs/screenshots/issue-499/evidence.test.ts` | F | F | C4 |
| `evals/roles/controls.test.ts` | P | P | — |
| `evals/roles/isolation.test.ts` | P | P | — |
| `evals/roles/lifecycle.test.ts` | P | P | — |
| `evals/roles/manifest.test.ts` | P | P | — |
| `evals/roles/scoring.test.ts` | P | P | — |
| `landing/site/copy.test.ts` | P | P | — |
| `landing/worker.test.ts` | P | P | — |
| `next.config.test.ts` | P | P | — |
| `scripts/audit-with-retry.test.ts` | F | F | C5 |
| `scripts/bootstrap-runtime-host.test.ts` | P | P | — |
| `scripts/bun-runtime-workflow.test.ts` | P | P | — |
| `scripts/capture-directory.test.ts` | P | P | — |
| `scripts/capture-mobile-v2.test.ts` | P | P | — |
| `scripts/capture-readme-media.test.ts` | P | P | — |
| `scripts/ci-platform-scope.test.ts` | P | P | — |
| `scripts/cutover-shared-claude-projects.test.ts` | P | P | — |
| `scripts/demo-capture.test.ts` | P | P | — |
| `scripts/demo-motion.test.ts` | P | P | — |
| `scripts/deploy-staging.test.ts` | P | P | — |
| `scripts/dockerfile-permissions.test.ts` | P | P | — |
| `scripts/first-message-design.test.ts` | P | P | — |
| `scripts/harness-ledger.test.ts` | P | P | — |
| `scripts/install-mcp.test.ts` | P | P | — |
| `scripts/merge-batch.test.ts` | P | P | — |
| `scripts/newcomer-install.test.ts` | P | P | — |
| `scripts/npm-package-smoke-diagnostic.test.ts` | P | P | — |
| `scripts/npm-package-smoke.test.ts` | F | F | C6 |
| `scripts/privacy-media-workflow.test.ts` | F | F | C7 |
| `scripts/privacy-publication-gate.test.ts` | F | F | C8 |
| `scripts/profileBrowser.browser.test.ts` | G | G | — |
| `scripts/publish-workflow.test.ts` | F | F | C9 |
| `scripts/rebuild.test.ts` | P | P | — |
| `scripts/rollback-runtime-host.test.ts` | P | P | — |
| `scripts/runtime-host-viewer-adapter.test.ts` | P | P | — |
| `scripts/transcript-search-fixture.test.ts` | P | P | — |
| `scripts/transcript-search-replay.test.ts` | P | P | — |
| `scripts/usage-metrics.test.ts` | P | P | — |
| `scripts/verify-viewer-runtime.test.ts` | P | P | — |
| `src/app/api/access/phone/route.test.ts` | P | P | — |
| `src/app/api/account-migration-get-purity.test.ts` | P | P | — |
| `src/app/api/account-migrations/[intentId]/action.test.ts` | P | P | — |
| `src/app/api/account-project-bindings/route.test.ts` | P | P | — |
| `src/app/api/accounts/claude/login/[operationId]/route.test.ts` | P | P | — |
| `src/app/api/accounts/claude/route.test.ts` | F | P | C10 |
| `src/app/api/accounts/codex/active/route.test.ts` | P | P | — |
| `src/app/api/accounts/codex/limits/route.test.ts` | P | P | — |
| `src/app/api/accounts/codex/reset-credits/route.test.ts` | P | P | — |
| `src/app/api/accounts/codex/route.test.ts` | P | P | — |
| `src/app/api/accounts/copilot/route.test.ts` | P | P | — |
| `src/app/api/accounts/route.test.ts` | P | P | — |
| `src/app/api/activity/route.test.ts` | P | P | — |
| `src/app/api/agent/snapshot/route.test.ts` | P | P | — |
| `src/app/api/agent/snapshot/standalone.integration.test.ts` | G | G | — |
| `src/app/api/answer/route.test.ts` | P | P | — |
| `src/app/api/artifact/frame/[...rest]/route.test.ts` | P | P | — |
| `src/app/api/artifact/route.test.ts` | P | P | — |
| `src/app/api/attention/route.busy.test.ts` | P | P | — |
| `src/app/api/attention/route.storeBusy.test.ts` | P | P | — |
| `src/app/api/board/route.test.ts` | F | P | C11 |
| `src/app/api/bridge/route.test.ts` | P | P | — |
| `src/app/api/conversation-host/route.test.ts` | P | P | — |
| `src/app/api/conversations/[conversationId]/migration/route.test.ts` | P | P | — |
| `src/app/api/conversations/route.test.ts` | P | P | — |
| `src/app/api/external-relay/route.test.ts` | P | P | — |
| `src/app/api/files/cacheUpgrade.real.test.ts` | F | P | C12 |
| `src/app/api/files/deliveryAttention.integration.test.ts` | P | P | — |
| `src/app/api/files/response.perf.test.ts` | F | P | C13 |
| `src/app/api/files/route.pin.rideAlong.test.ts` | P | P | — |
| `src/app/api/files/route.test.ts` | F | P | C14 |
| `src/app/api/files/scanCache.real.test.ts` | F | P | C15 |
| `src/app/api/image/route.test.ts` | P | P | — |
| `src/app/api/links/agents/route.test.ts` | P | P | — |
| `src/app/api/links/route.test.ts` | P | P | — |
| `src/app/api/log/project-delete/route.test.ts` | P | P | — |
| `src/app/api/log/route.test.ts` | P | P | — |
| `src/app/api/log/suggestions/route.test.ts` | P | P | — |
| `src/app/api/materializationFence.route.test.ts` | P | P | — |
| `src/app/api/monitor/runs/route.test.ts` | P | P | — |
| `src/app/api/monitor/seat-tick/route.test.ts` | P | P | — |
| `src/app/api/monitor/seat-tick/settings/route.test.ts` | P | P | — |
| `src/app/api/operator/settings/route.test.ts` | P | P | — |
| `src/app/api/orchestrator/ghost/route.test.ts` | P | P | — |
| `src/app/api/orchestrator/reports/route.test.ts` | P | P | — |
| `src/app/api/orchestrator/seat/route.test.ts` | P | P | — |
| `src/app/api/orchestrator/seat/status/incumbent.test.ts` | P | P | — |
| `src/app/api/pipelines/[id]/route.test.ts` | P | P | — |
| `src/app/api/pipelines/preflight/route.test.ts` | P | P | — |
| `src/app/api/pipelines/route.admission.test.ts` | P | P | — |
| `src/app/api/pipelines/route.busy.test.ts` | P | P | — |
| `src/app/api/pipelines/route.test.ts` | F | P | C16 |
| `src/app/api/pipelines/tick/route.test.ts` | P | P | — |
| `src/app/api/projects/directorySuggestionRoutes.test.ts` | P | P | — |
| `src/app/api/projects/settings/route.test.ts` | P | P | — |
| `src/app/api/roles/route.test.ts` | F | P | C17 |
| `src/app/api/routeExports.test.ts` | P | P | — |
| `src/app/api/runtime/deployments/capabilities/v1/route.test.ts` | P | P | — |
| `src/app/api/runtime/deployments/read-contract.test.ts` | P | P | — |
| `src/app/api/runtime/deployments/route.test.ts` | P | P | — |
| `src/app/api/runtime/hosts/route.test.ts` | P | P | — |
| `src/app/api/runtime/operations/[operationId]/settlement.test.ts` | F | P | C18 |
| `src/app/api/runtime/realtime/route.injection.test.ts` | F | P | C10 |
| `src/app/api/runtime/realtime/route.test.ts` | P | P | — |
| `src/app/api/runtime/realtime/voicePersona.routes.test.ts` | P | P | — |
| `src/app/api/search/memory/route.test.ts` | P | P | — |
| `src/app/api/search/transcripts/route.test.ts` | P | P | — |
| `src/app/api/session/title/route.test.ts` | P | P | — |
| `src/app/api/spawn/accountError.test.ts` | P | P | — |
| `src/app/api/spawn/membership.test.ts` | P | P | — |
| `src/app/api/spawn/policy/route.test.ts` | P | P | — |
| `src/app/api/spawn/route.admission.test.ts` | F | P | C19 |
| `src/app/api/spawn/route.binding.test.ts` | P | P | — |
| `src/app/api/spawn/route.engineKeys.test.ts` | P | P | — |
| `src/app/api/spawn/route.launcher.test.ts` | P | P | — |
| `src/app/api/spawn/route.test.ts` | P | P | — |
| `src/app/api/spawn/sourceCwd.test.ts` | P | P | — |
| `src/app/api/spawn/validate/route.test.ts` | P | P | — |
| `src/app/api/staging/route.test.ts` | P | P | — |
| `src/app/api/tasks/[id]/assignment/route.test.ts` | P | P | — |
| `src/app/api/tasks/[id]/send/route.test.ts` | P | P | — |
| `src/app/api/tasks/[id]/spawn/route.binding.test.ts` | P | P | — |
| `src/app/api/tasks/[id]/spawn/route.test.ts` | P | P | — |
| `src/app/api/tasks/activityLedger.test.ts` | P | P | — |
| `src/app/api/tasks/boardBandLimit.test.ts` | P | P | — |
| `src/app/api/tasks/route.test.ts` | P | P | — |
| `src/app/api/team/routes.test.ts` | P | P | — |
| `src/app/api/telegram/bot/route.test.ts` | P | P | — |
| `src/app/api/telegram/reports/route.test.ts` | P | P | — |
| `src/app/api/telegram/route.test.ts` | F | P | C20 |
| `src/app/api/telemetry/route.test.ts` | P | P | — |
| `src/app/api/tmux/route.test.ts` | P | P | — |
| `src/app/api/tmux/targets/route.test.ts` | P | P | — |
| `src/app/api/transcribe/backend/route.test.ts` | P | P | — |
| `src/app/api/transcribe/key/route.test.ts` | F | P | C20 |
| `src/app/api/transcribe/route.test.ts` | P | P | — |
| `src/app/api/transcribe/token/route.test.ts` | P | P | — |
| `src/app/api/tts/route.test.ts` | P | P | — |
| `src/app/api/view/presence/route.test.ts` | P | P | — |
| `src/app/favicon.ico/route.test.ts` | P | P | — |
| `src/app/layout.metadata.test.ts` | P | P | — |
| `src/app/servedPayloadSecrets.test.ts` | F | P | C21 |
| `src/components/AccountBadge.dom.test.tsx` | P | P | — |
| `src/components/AccountBadge.render.test.tsx` | F | P | C22 |
| `src/components/AccountsPanel.dom.test.tsx` | P | P | — |
| `src/components/AccountsPanel.mobile.dom.test.tsx` | P | P | — |
| `src/components/AccountsPanel.render.test.tsx` | P | P | — |
| `src/components/AgentControlStrip.action.test.tsx` | P | P | — |
| `src/components/AgentControlStrip.dom.test.tsx` | P | P | — |
| `src/components/AgentControlStrip.interruptNote.dom.test.tsx` | P | P | — |
| `src/components/AsksYouRow.dom.test.tsx` | P | P | — |
| `src/components/AttachTerminalDialog.action.test.tsx` | P | P | — |
| `src/components/AttachTerminalDialog.dom.test.tsx` | P | P | — |
| `src/components/BoardSearchEntry.dom.test.tsx` | P | P | — |
| `src/components/BootShell.dom.test.tsx` | P | P | — |
| `src/components/BranchPane.lineage.render.test.tsx` | P | P | — |
| `src/components/BranchPane.liveness.dom.test.tsx` | P | P | — |
| `src/components/BranchPane.mobileChrome.dom.test.tsx` | F | P | C23 |
| `src/components/BranchPane.paneTones.test.ts` | P | P | — |
| `src/components/BranchPane.relations.dom.test.tsx` | F | P | C23 |
| `src/components/BranchPane.render.test.tsx` | F | F | C24 |
| `src/components/BranchPane.spawn.dom.test.tsx` | F | P | C23 |
| `src/components/BranchPane.spawn.render.test.tsx` | F | F | C24 |
| `src/components/BranchPane.stageTitle.render.test.tsx` | F | F | C24 |
| `src/components/BranchPane.superseded.render.test.tsx` | F | F | C24 |
| `src/components/BurndownPanel.dom.test.tsx` | P | P | — |
| `src/components/CardStatusBadge.render.test.tsx` | P | P | — |
| `src/components/ComposerBar.attachmentGate.dom.test.tsx` | P | P | — |
| `src/components/ComposerBar.dom.test.tsx` | P | P | — |
| `src/components/ComposerBar.fileAttachments.dom.test.tsx` | P | P | — |
| `src/components/ComposerBar.mobileUnit.dom.test.tsx` | P | P | — |
| `src/components/ConversationList.dom.test.tsx` | P | P | — |
| `src/components/ConversationList.pagination.dom.test.tsx` | P | P | — |
| `src/components/DesktopConversations.dom.test.tsx` | P | P | — |
| `src/components/DirectoryPicker.dom.test.tsx` | P | P | — |
| `src/components/DirectoryPicker.test.ts` | P | P | — |
| `src/components/DraftAgentPane.accounts.dom.test.tsx` | P | P | — |
| `src/components/DraftAgentPane.dom.test.tsx` | P | P | — |
| `src/components/DraftAgentPane.launchOutbox.dom.test.tsx` | P | P | — |
| `src/components/DraftAgentPane.receiptAttach.dom.test.tsx` | P | P | — |
| `src/components/DraftAgentPane.render.test.tsx` | P | P | — |
| `src/components/DraftAgentPane.structuredCopy.dom.test.tsx` | P | P | — |
| `src/components/DraftLaunchStatus.render.test.tsx` | P | P | — |
| `src/components/DraftLaunchStatus.structured.render.test.tsx` | P | P | — |
| `src/components/EffortPills.slot.dom.test.tsx` | F | F | C25 |
| `src/components/EngineAccountSwitch.dom.test.tsx` | P | P | — |
| `src/components/EngineAccountSwitch.test.tsx` | P | P | — |
| `src/components/FavoriteCrown.dom.test.tsx` | P | P | — |
| `src/components/KeepAwakeControl.dom.test.tsx` | P | P | — |
| `src/components/LimitsFooter.dom.test.tsx` | P | P | — |
| `src/components/LimitsFooter.test.ts` | P | P | — |
| `src/components/LogFeed.deliveryUncertainty.dom.test.tsx` | F | F | C26 |
| `src/components/LogFeed.imageViewer.dom.test.tsx` | P | P | — |
| `src/components/LogFeed.launchReceiptChip.dom.test.tsx` | F | F | C27 |
| `src/components/LogFeed.liveToolRows.dom.test.tsx` | F | F | C27 |
| `src/components/LogFeed.mobileChrome.dom.test.tsx` | P | P | — |
| `src/components/LogFeed.oneMessageOneRow.dom.test.tsx` | P | P | — |
| `src/components/LogFeed.outboxTailOrder.dom.test.tsx` | F | F | C27 |
| `src/components/LogFeed.prependAnchor.dom.test.tsx` | P | P | — |
| `src/components/LogFeed.refusedSend.dom.test.tsx` | P | P | — |
| `src/components/LogFeed.spawnPathFlip.dom.test.tsx` | F | F | C27 |
| `src/components/LogFeed.startingWindow.dom.test.tsx` | P | P | — |
| `src/components/LogFeed.suggestedReplies.dom.test.tsx` | P | P | — |
| `src/components/MicButton.keyboard.dom.test.tsx` | P | P | — |
| `src/components/MicButton.test.ts` | P | P | — |
| `src/components/MigrationRibbon.render.test.tsx` | P | P | — |
| `src/components/NativeQueuePanel.dom.test.tsx` | P | P | — |
| `src/components/OverviewBoard.catalog.render.test.tsx` | P | P | — |
| `src/components/OverviewBoard.firstRun.dom.test.tsx` | P | P | — |
| `src/components/OverviewBoard.kanban.dom.test.tsx` | F | P | C28 |
| `src/components/OverviewBoard.loading.dom.test.tsx` | P | P | — |
| `src/components/OverviewBoard.render.test.tsx` | P | P | — |
| `src/components/PlanChip.render.test.tsx` | P | P | — |
| `src/components/ProcessStatusControls.action.test.tsx` | P | P | — |
| `src/components/ProjectAccounts.render.test.tsx` | P | P | — |
| `src/components/ProjectDashboard.backgroundTaskDock.dom.test.tsx` | F | P | C29 |
| `src/components/ProjectDashboard.catalogFailure.dom.test.tsx` | P | P | — |
| `src/components/ProjectDashboard.empty.dom.test.tsx` | P | P | — |
| `src/components/ProjectDashboard.flash.dom.test.tsx` | P | P | — |
| `src/components/ProjectDashboard.headerBar.dom.test.tsx` | F | P | C30 |
| `src/components/ProjectDashboard.inlineCatalog.dom.test.tsx` | P | P | — |
| `src/components/ProjectDashboard.launchClaim.dom.test.tsx` | F | P | C31 |
| `src/components/ProjectDashboard.loadingStates.dom.test.tsx` | P | P | — |
| `src/components/ProjectDashboard.looseReader.dom.test.tsx` | P | P | — |
| `src/components/ProjectDashboard.mobileLaunchFocus.dom.test.tsx` | P | P | — |
| `src/components/ProjectDashboard.pipelineNavigation.dom.test.tsx` | P | P | — |
| `src/components/ProjectDashboard.searchLanding.dom.test.tsx` | P | P | — |
| `src/components/ProjectDashboard.seatTasks.dom.test.tsx` | P | P | — |
| `src/components/ProjectDashboard.selection.dom.test.tsx` | P | P | — |
| `src/components/ProjectDashboard.shelf.dom.test.tsx` | F | P | C30 |
| `src/components/ProjectDashboard.test.ts` | P | P | — |
| `src/components/ProjectDashboard.unownedConversations.dom.test.tsx` | P | P | — |
| `src/components/ProjectDashboard.viewSwitch.dom.test.tsx` | P | P | — |
| `src/components/ProjectRail.dom.test.tsx` | P | P | — |
| `src/components/ProjectRail.firstRun.dom.test.tsx` | P | P | — |
| `src/components/ProjectRail.footerFold.dom.test.tsx` | P | P | — |
| `src/components/ProjectRail.header.dom.test.tsx` | P | P | — |
| `src/components/ProjectTrash.test.ts` | P | P | — |
| `src/components/RateLimitBadge.dom.test.tsx` | P | P | — |
| `src/components/RateLimitBadge.test.tsx` | P | P | — |
| `src/components/ReasoningControls.render.test.tsx` | P | P | — |
| `src/components/ResourcesFooter.dom.test.tsx` | P | P | — |
| `src/components/ResourcesFooter.test.ts` | P | P | — |
| `src/components/RuntimePill.accountIntent.dom.test.tsx` | P | P | — |
| `src/components/RuntimePill.dom.test.tsx` | P | P | — |
| `src/components/RuntimePill.limitAccounts.dom.test.tsx` | F | P | C32 |
| `src/components/RuntimePill.persistence.dom.test.tsx` | F | P | C33 |
| `src/components/SelectedContextBadge.render.test.tsx` | P | P | — |
| `src/components/SoundToggle.dom.test.tsx` | P | P | — |
| `src/components/StagingBadge.dom.test.tsx` | P | P | — |
| `src/components/StateWritesAlert.dom.test.tsx` | P | P | — |
| `src/components/SwitchCard.anatomy.render.test.tsx` | P | P | — |
| `src/components/SwitchCard.attention.render.test.tsx` | P | P | — |
| `src/components/SwitchCard.status.render.test.tsx` | P | P | — |
| `src/components/TaskHeader.killConfirm.dom.test.tsx` | P | P | — |
| `src/components/TelegramBot.dom.test.tsx` | P | P | — |
| `src/components/TelegramBot.render.test.tsx` | P | P | — |
| `src/components/TelegramConnect.dom.test.tsx` | P | P | — |
| `src/components/TelegramConnect.render.test.tsx` | P | P | — |
| `src/components/TelegramReports.render.test.tsx` | F | F | C34 |
| `src/components/TmuxComposer.contextMode.dom.test.tsx` | P | P | — |
| `src/components/TmuxComposer.deadHostComposerUsable.dom.test.tsx` | P | P | — |
| `src/components/TmuxComposer.deadRecovery.dom.test.tsx` | P | P | — |
| `src/components/TmuxComposer.deliveryNotice.dom.test.tsx` | P | P | — |
| `src/components/TmuxComposer.deliveryState.dom.test.tsx` | P | P | — |
| `src/components/TmuxComposer.dom.test.tsx` | P | P | — |
| `src/components/TmuxComposer.draftAttachments.dom.test.tsx` | P | P | — |
| `src/components/TmuxComposer.focus.dom.test.tsx` | P | P | — |
| `src/components/TmuxComposer.heldRelease.dom.test.tsx` | P | P | — |
| `src/components/TmuxComposer.inject.dom.test.tsx` | P | P | — |
| `src/components/TmuxComposer.injectReceipts.dom.test.tsx` | P | P | — |
| `src/components/TmuxComposer.liveRefreshFocus.dom.test.tsx` | F | F | C35 |
| `src/components/TmuxComposer.migrationHold.dom.test.tsx` | P | P | — |
| `src/components/TmuxComposer.nativeQueue.dom.test.tsx` | P | P | — |
| `src/components/TmuxComposer.operationReadBack.dom.test.tsx` | P | P | — |
| `src/components/TmuxComposer.pendingImages.dom.test.tsx` | P | P | — |
| `src/components/TmuxComposer.queueFirst.dom.test.tsx` | P | P | — |
| `src/components/TmuxComposer.reconciliation.dom.test.tsx` | P | P | — |
| `src/components/TmuxComposer.reconciliationExpiry.dom.test.tsx` | P | P | — |
| `src/components/TmuxComposer.runtimeSnapshot.dom.test.tsx` | F | F | C36 |
| `src/components/TmuxComposer.selectedContext.dom.test.tsx` | P | P | — |
| `src/components/TmuxComposer.sendReadiness.dom.test.tsx` | F | P | C37 |
| `src/components/TmuxComposer.sendSlot.dom.test.tsx` | P | P | — |
| `src/components/TmuxComposer.staleKey.dom.test.tsx` | F | F | C36 |
| `src/components/TmuxComposer.taskChips.dom.test.tsx` | P | P | — |
| `src/components/TmuxComposer.test.ts` | P | P | — |
| `src/components/TmuxComposer.viewerPrelude.dom.test.tsx` | P | P | — |
| `src/components/TmuxComposer.voiceButton.dom.test.tsx` | P | P | — |
| `src/components/TooltipBubble.test.ts` | P | P | — |
| `src/components/TurnStatusBar.dom.test.tsx` | P | P | — |
| `src/components/Viewer.attentionMount.test.ts` | P | P | — |
| `src/components/Viewer.catalogFailure.dom.test.tsx` | P | P | — |
| `src/components/Viewer.deepLink.dom.test.tsx` | P | P | — |
| `src/components/Viewer.mobileSwipe.dom.test.tsx` | P | P | — |
| `src/components/Viewer.needsYou.dom.test.tsx` | P | P | — |
| `src/components/Viewer.orchestratorDock.dom.test.tsx` | P | P | — |
| `src/components/Viewer.overviewPhone.dom.test.tsx` | F | P | C38 |
| `src/components/Viewer.railHidden.dom.test.tsx` | P | P | — |
| `src/components/Viewer.switching.dom.test.tsx` | F | F | C39 |
| `src/components/Viewer.test.ts` | F | F | C40 |
| `src/components/VoiceConversation.dom.test.tsx` | P | P | — |
| `src/components/WakeupChip.dom.test.tsx` | P | P | — |
| `src/components/WakeupChip.render.test.tsx` | P | P | — |
| `src/components/activity/ActivityDashboard.dom.test.tsx` | P | P | — |
| `src/components/activity/format.test.ts` | P | P | — |
| `src/components/agentCapabilities.test.ts` | P | P | — |
| `src/components/attention.test.ts` | P | P | — |
| `src/components/attention/AttentionHost.dom.test.tsx` | P | P | — |
| `src/components/attention/AttentionHost.phoneNotice.dom.test.tsx` | P | P | — |
| `src/components/attention/AttentionIsland.dom.test.tsx` | P | P | — |
| `src/components/attention/AttentionPanel.dom.test.tsx` | P | P | — |
| `src/components/attention/AttentionToast.arrival.dom.test.tsx` | P | P | — |
| `src/components/attention/AttentionToast.dom.test.tsx` | P | P | — |
| `src/components/attention/MobileAttentionSheet.dom.test.tsx` | F | F | C41 |
| `src/components/attention/arrivalPulse.dom.test.tsx` | P | P | — |
| `src/components/attention/attentionQueue.test.ts` | P | P | — |
| `src/components/attention/decision.test.ts` | P | P | — |
| `src/components/attention/dismissalOverlay.test.ts` | P | P | — |
| `src/components/attention/navigate.test.ts` | P | P | — |
| `src/components/attention/needsYouPanel.test.ts` | P | P | — |
| `src/components/attention/returnProjectMemory.test.ts` | P | P | — |
| `src/components/bridgeTurnCommit.test.ts` | P | P | — |
| `src/components/cardAnatomy.render.test.tsx` | P | P | — |
| `src/components/cardStatus.test.ts` | P | P | — |
| `src/components/childCapabilities.test.ts` | P | P | — |
| `src/components/composerAdmissionDeadline.test.ts` | P | P | — |
| `src/components/composerContextMode.test.ts` | P | P | — |
| `src/components/composerDeliveryReconciliation.integration.test.ts` | P | P | — |
| `src/components/composerHistory.test.ts` | P | P | — |
| `src/components/conversation/DeputyBlock.dom.test.tsx` | P | P | — |
| `src/components/conversation/LaunchChips.render.test.tsx` | P | P | — |
| `src/components/conversation/OutboxBubbles.delivery.dom.test.tsx` | P | P | — |
| `src/components/conversation/OutboxBubbles.switchHold.dom.test.tsx` | P | P | — |
| `src/components/conversation/conversationWindow.browser.test.tsx` | G | G | — |
| `src/components/conversation/deputyPlacement.test.ts` | P | P | — |
| `src/components/conversation/issue626Lifecycle.test.ts` | F | P | C42 |
| `src/components/conversation/liveTurnHandoff.test.ts` | P | P | — |
| `src/components/conversation/liveTurnMarkdown.dom.test.tsx` | P | P | — |
| `src/components/conversation/liveTurnOverlayBound.dom.test.tsx` | P | P | — |
| `src/components/conversation/liveTurnPaneVisibility.dom.test.tsx` | P | P | — |
| `src/components/conversation/liveTurnStallPath.dom.test.tsx` | F | P | C43 |
| `src/components/conversation/liveTurnToolRows.dom.test.tsx` | P | P | — |
| `src/components/conversation/messageRow.dom.test.tsx` | P | P | — |
| `src/components/conversation/messageRow.test.ts` | P | P | — |
| `src/components/conversation/outbox.test.ts` | P | P | — |
| `src/components/conversation/outboxEchoShapes.test.ts` | P | P | — |
| `src/components/conversation/submissionJoin.test.ts` | P | P | — |
| `src/components/conversation/tailOrder.test.ts` | P | P | — |
| `src/components/draft/AgentLaunchControls.dom.test.tsx` | P | P | — |
| `src/components/draftSpawn.test.ts` | P | P | — |
| `src/components/effort.test.ts` | P | P | — |
| `src/components/externalRelay/ExternalRelaySection.dom.test.tsx` | F | F | C44 |
| `src/components/feed/FeedItem.actions.render.test.tsx` | P | P | — |
| `src/components/feed/FeedItem.mobile.dom.test.tsx` | P | P | — |
| `src/components/feed/MandateCard.dom.test.tsx` | P | P | — |
| `src/components/feed/QuestionCard.delivery.dom.test.tsx` | P | P | — |
| `src/components/feed/QuestionCard.dismiss.dom.test.tsx` | P | P | — |
| `src/components/feed/QuestionCard.mobile.dom.test.tsx` | P | P | — |
| `src/components/feed/ReasoningVisibility.dom.test.tsx` | P | P | — |
| `src/components/feed/ResponseDuration.render.test.tsx` | P | P | — |
| `src/components/feed/SpeakButton.dom.test.tsx` | P | P | — |
| `src/components/feed/SpeakMenu.placement.test.ts` | P | P | — |
| `src/components/feed/SuggestedReplies.dom.test.tsx` | P | P | — |
| `src/components/feed/SuggestedReplies.mobile.dom.test.tsx` | P | P | — |
| `src/components/feed/actionGeometry.dom.test.tsx` | P | P | — |
| `src/components/feed/ansi.test.ts` | P | P | — |
| `src/components/feed/artifactAnchor.dom.test.tsx` | P | P | — |
| `src/components/feed/cards/CmdGroupCard.mobile.dom.test.tsx` | P | P | — |
| `src/components/feed/cards/ToolCard.imageOutput.dom.test.tsx` | P | P | — |
| `src/components/feed/cards/ToolCard.mobile.dom.test.tsx` | P | P | — |
| `src/components/feed/cards/WakeupCard.dom.test.tsx` | P | P | — |
| `src/components/feed/cards/WakeupCard.render.test.tsx` | P | P | — |
| `src/components/feed/cards/readableTool.dom.test.tsx` | P | P | — |
| `src/components/feed/cards/toolCards.render.test.tsx` | P | P | — |
| `src/components/feed/cards/toolDisclosure.dom.test.tsx` | P | P | — |
| `src/components/feed/cards/toolLifecycle.dom.test.tsx` | P | P | — |
| `src/components/feed/cards/toolRowParity.dom.test.tsx` | P | P | — |
| `src/components/feed/codexReadable.parse.test.ts` | P | P | — |
| `src/components/feed/codexTurnChronology.parse.test.ts` | P | P | — |
| `src/components/feed/contextTokens.parse.test.ts` | P | P | — |
| `src/components/feed/contextTokens.test.ts` | P | P | — |
| `src/components/feed/copilot.parse.test.ts` | P | P | — |
| `src/components/feed/deliveredOccurrences.test.ts` | P | P | — |
| `src/components/feed/diff.test.ts` | P | P | — |
| `src/components/feed/mandateMessage.test.ts` | P | P | — |
| `src/components/feed/markdown.test.tsx` | P | P | — |
| `src/components/feed/mcpIdentity.parse.test.tsx` | P | P | — |
| `src/components/feed/mcpRedaction.parse.test.tsx` | P | P | — |
| `src/components/feed/messageLinks.dom.test.tsx` | P | P | — |
| `src/components/feed/messageProvenance.parse.test.tsx` | P | P | — |
| `src/components/feed/messageProvenance.retry.dom.test.tsx` | P | P | — |
| `src/components/feed/openclaw.parse.test.ts` | P | P | — |
| `src/components/feed/parse.test.ts` | P | P | — |
| `src/components/feed/readableTool.parse.test.ts` | P | P | — |
| `src/components/feed/scrollMemory.test.ts` | P | P | — |
| `src/components/feed/selectedContext.parse.test.tsx` | P | P | — |
| `src/components/feed/senderLine.dom.test.tsx` | F | F | C45 |
| `src/components/feed/speakableAnswer.test.ts` | P | P | — |
| `src/components/feed/structuredUserProvenance.retry.dom.test.tsx` | P | P | — |
| `src/components/feed/structuredUserProvenance.test.tsx` | P | P | — |
| `src/components/feed/toolBlocks.test.ts` | P | P | — |
| `src/components/feed/toolLifecycle.parse.test.ts` | P | P | — |
| `src/components/feed/tools.test.ts` | P | P | — |
| `src/components/feed/transcriptOrder.test.ts` | P | P | — |
| `src/components/feed/ttsKaraoke.dom.test.ts` | P | P | — |
| `src/components/feed/ttsSession.dom.test.ts` | P | P | — |
| `src/components/feed/visibleAnswerRows.dom.test.ts` | P | P | — |
| `src/components/feed/voicePersona.render.test.tsx` | P | P | — |
| `src/components/flows/FlowDialog.dom.test.tsx` | P | P | — |
| `src/components/flows/RoundDeck.dom.test.tsx` | P | P | — |
| `src/components/flows/RoundDeck.strip.dom.test.tsx` | F | F | C46 |
| `src/components/flows/directReviewGroups.test.ts` | P | P | — |
| `src/components/flows/flowModel.test.ts` | P | P | — |
| `src/components/flows/reviewDeckDisclosure.test.ts` | P | P | — |
| `src/components/focusRequestEdge.test.ts` | P | P | — |
| `src/components/imageAttachments.objectUrl.dom.test.tsx` | P | P | — |
| `src/components/imageAttachments.progressive.dom.test.tsx` | P | P | — |
| `src/components/kanban/KanbanAccounts.dom.test.tsx` | F | P | C47 |
| `src/components/kanban/KanbanAccountsRuntime.dom.test.tsx` | P | P | — |
| `src/components/kanban/KanbanAskOrchestrator.dom.test.tsx` | P | P | — |
| `src/components/kanban/KanbanBoard.dom.test.tsx` | F | F | C48 |
| `src/components/kanban/KanbanDetails.dom.test.tsx` | P | P | — |
| `src/components/kanban/KanbanDismiss.dom.test.tsx` | P | P | — |
| `src/components/kanban/KanbanDrafts.dom.test.tsx` | P | P | — |
| `src/components/kanban/KanbanEditing.dom.test.tsx` | F | F | C48 |
| `src/components/kanban/KanbanOpenAgents.dom.test.tsx` | P | P | — |
| `src/components/kanban/KanbanOpenableConversations.dom.test.tsx` | F | F | C49 |
| `src/components/kanban/KanbanPipelines.dom.test.tsx` | F | P | C50 |
| `src/components/kanban/KanbanPresence.dom.test.tsx` | P | P | — |
| `src/components/kanban/KanbanReaders.dom.test.tsx` | F | P | C28 |
| `src/components/kanban/KanbanStages.dom.test.tsx` | P | P | — |
| `src/components/kanban/KanbanTickNotice.dom.test.tsx` | P | P | — |
| `src/components/kanban/KanbanUndo.dom.test.tsx` | F | P | C28 |
| `src/components/kanban/RemoteCard.dom.test.tsx` | P | P | — |
| `src/components/kanban/StageGlyph.dom.test.tsx` | P | P | — |
| `src/components/kanban/accountChoice.test.ts` | P | P | — |
| `src/components/kanban/askOrchestrator.test.ts` | P | P | — |
| `src/components/kanban/boardHistory.test.ts` | P | P | — |
| `src/components/kanban/boardScrollers.test.ts` | P | P | — |
| `src/components/kanban/conversationHeights.test.ts` | P | P | — |
| `src/components/kanban/kanbanBoard.browser.test.tsx` | G | G | — |
| `src/components/kanban/kanbanModel.test.ts` | P | P | — |
| `src/components/kanban/modelGlyph.test.ts` | P | P | — |
| `src/components/kanban/pipelineGraph.test.ts` | P | P | — |
| `src/components/kanban/readerMemory.test.ts` | P | P | — |
| `src/components/kanban/seatFold.dom.test.tsx` | P | P | — |
| `src/components/kanban/stageDisplayName.test.ts` | P | P | — |
| `src/components/kanban/stageIdentity.test.ts` | P | P | — |
| `src/components/kanban/stagesModel.test.ts` | P | P | — |
| `src/components/kanban/taskText.test.ts` | P | P | — |
| `src/components/kanban/useColumnDwell.dom.test.tsx` | P | P | — |
| `src/components/kanban/useTaskMutations.test.ts` | P | P | — |
| `src/components/launchHistoryModel.test.ts` | P | P | — |
| `src/components/launchedConversations.test.ts` | P | P | — |
| `src/components/layers.test.ts` | F | F | C51 |
| `src/components/links/LinkedSettingsDialog.dom.test.tsx` | P | P | — |
| `src/components/mobile/MobileBoard.dom.test.tsx` | F | P | C30 |
| `src/components/mobile/MobileConversationMenu.answers.dom.test.tsx` | P | P | — |
| `src/components/mobile/MobileFocusView.badges.dom.test.tsx` | F | P | C23 |
| `src/components/mobile/MobileFocusView.conversation.dom.test.tsx` | P | P | — |
| `src/components/mobile/MobileFocusView.keyboardInset.dom.test.tsx` | F | F | C52 |
| `src/components/mobile/MobileFocusView.seen.dom.test.tsx` | P | P | — |
| `src/components/mobile/MobileFocusView.strip.dom.test.tsx` | F | F | C46 |
| `src/components/mobile/MobileFocusView.superseded.dom.test.tsx` | F | P | C23 |
| `src/components/mobile/MobileFocusView.viewport.dom.test.tsx` | P | P | — |
| `src/components/mobile/MobileHostSheet.dom.test.tsx` | P | P | — |
| `src/components/mobile/MobileKanban.dom.test.tsx` | P | P | — |
| `src/components/mobile/MobileOrchestratorSheet.render.test.tsx` | P | P | — |
| `src/components/mobile/MobilePipelineScreen.actions.dom.test.tsx` | P | P | — |
| `src/components/mobile/MobilePipelineScreen.dom.test.tsx` | P | P | — |
| `src/components/mobile/MobilePipelinesScreen.dom.test.tsx` | P | P | — |
| `src/components/mobile/MobileReceipt.dom.test.tsx` | P | P | — |
| `src/components/mobile/MobileRemoteTask.dom.test.tsx` | P | P | — |
| `src/components/mobile/MobileSeatTickSheet.dom.test.tsx` | P | P | — |
| `src/components/mobile/MobileSheet.dom.test.tsx` | P | P | — |
| `src/components/mobile/MobileShell.board.dom.test.tsx` | F | P | C30 |
| `src/components/mobile/MobileShell.dom.test.tsx` | P | P | — |
| `src/components/mobile/MobileSwipeRow.dom.test.tsx` | P | P | — |
| `src/components/mobile/MobileTaskScreen.dom.test.tsx` | P | P | — |
| `src/components/mobile/MobileTaskScreen.entry.dom.test.tsx` | F | P | C30 |
| `src/components/mobile/chatBudget.test.ts` | P | P | — |
| `src/components/mobile/directReviewDeck.dom.test.tsx` | F | P | C53 |
| `src/components/mobile/issue1347Evidence.browser.test.tsx` | F | P | C54 |
| `src/components/mobile/issue1671Evidence.browser.test.tsx` | G | G | — |
| `src/components/mobile/mobileBoardModel.test.ts` | P | P | — |
| `src/components/mobile/mobileChatState.test.ts` | P | P | — |
| `src/components/mobile/mobileHeaderFit.dom.test.tsx` | F | F | C55 |
| `src/components/mobile/mobileNav.test.ts` | P | P | — |
| `src/components/mobile/mobileOrchestratorControls.dom.test.tsx` | F | P | C23 |
| `src/components/mobile/mobileOrchestratorLeaves.dom.test.tsx` | P | P | — |
| `src/components/mobile/mobileSeatCard.dom.test.tsx` | F | P | C23 |
| `src/components/mobile/orchestratorRowState.test.ts` | P | P | — |
| `src/components/mobile/overviewPhone.test.ts` | P | P | — |
| `src/components/mobile/phoneKanbanModel.test.ts` | F | F | C48 |
| `src/components/mobile/swipeIntent.test.ts` | P | P | — |
| `src/components/nativeQueueView.test.ts` | P | P | — |
| `src/components/onboarding/CheckStep.dom.test.tsx` | P | P | — |
| `src/components/onboarding/EnginesStep.dom.test.tsx` | P | P | — |
| `src/components/onboarding/OnboardingDialog.dom.test.tsx` | P | P | — |
| `src/components/onboarding/OnboardingWalk.dom.test.tsx` | P | P | — |
| `src/components/onboarding/PhoneStep.dom.test.tsx` | P | P | — |
| `src/components/onboarding/VoiceStep.dom.test.tsx` | P | P | — |
| `src/components/operatorCredential.dom.test.ts` | P | P | — |
| `src/components/orchestrator/IncumbentHeader.dom.test.tsx` | P | P | — |
| `src/components/orchestrator/OrchestratorDock.dom.test.tsx` | P | P | — |
| `src/components/orchestrator/OrchestratorPanel.dom.test.tsx` | F | F | C56 |
| `src/components/orchestrator/SeatReports.dom.test.tsx` | P | P | — |
| `src/components/orchestrator/SeatTickChip.dom.test.tsx` | P | P | — |
| `src/components/orchestrator/dockOpenState.dom.test.tsx` | P | P | — |
| `src/components/orchestrator/draftPrefill.dom.test.tsx` | P | P | — |
| `src/components/orchestrator/incumbent.test.ts` | P | P | — |
| `src/components/orchestrator/issue1681Evidence.browser.test.tsx` | G | G | — |
| `src/components/orchestrator/openSeatTick.test.ts` | P | P | — |
| `src/components/orchestrator/orchestratorAnswerCache.dom.test.tsx` | P | P | — |
| `src/components/orchestrator/reportLog/ReportLog.dom.test.tsx` | P | P | — |
| `src/components/orchestrator/seatComposerHoist.dom.test.tsx` | P | P | — |
| `src/components/orchestrator/seatPollVisibility.dom.test.tsx` | P | P | — |
| `src/components/orchestrator/seatState.test.ts` | F | F | C57 |
| `src/components/orchestrator/seatTickView.test.ts` | P | P | — |
| `src/components/orchestrator/taskChips.test.ts` | P | P | — |
| `src/components/orchestrator/useSeatPanel.dom.test.tsx` | P | P | — |
| `src/components/overlay/useAttentionOffers.dom.test.tsx` | P | P | — |
| `src/components/pipelines/PipelineBlock.dom.test.tsx` | P | P | — |
| `src/components/pipelines/PipelineEditor.legacyReview.dom.test.tsx` | P | P | — |
| `src/components/pipelines/PipelineHub.dom.test.tsx` | P | P | — |
| `src/components/pipelines/PipelineStrip.dom.test.tsx` | F | P | C58 |
| `src/components/pipelines/PipelineStrip.render.test.tsx` | F | P | C59 |
| `src/components/pipelines/PipelineStrip.test.ts` | P | P | — |
| `src/components/pipelines/PipelineTemplatePicker.dom.test.tsx` | P | P | — |
| `src/components/pipelines/StageEdgeControls.dom.test.tsx` | P | P | — |
| `src/components/pipelines/StagePlaceholderPane.dom.test.tsx` | P | P | — |
| `src/components/pipelines/VerdictPopover.render.test.tsx` | P | P | — |
| `src/components/pipelines/createDraftPipeline.dom.test.tsx` | P | P | — |
| `src/components/pipelines/pipelineBlockModel.test.ts` | P | P | — |
| `src/components/pipelines/pipelineModel.test.ts` | P | P | — |
| `src/components/pipelines/pipelinePlaceholderStages.test.ts` | P | P | — |
| `src/components/pipelines/remoteLaneSummary.dom.test.tsx` | P | P | — |
| `src/components/pipelines/stageCardAria.render.test.tsx` | P | P | — |
| `src/components/preview/ArtifactPreviewHost.dom.test.tsx` | P | P | — |
| `src/components/preview/DocumentPanes.dom.test.tsx` | P | P | — |
| `src/components/preview/PdfPane.dom.test.tsx` | P | P | — |
| `src/components/preview/highlightLines.test.ts` | P | P | — |
| `src/components/projectBoardMutations.test.ts` | F | P | C60 |
| `src/components/projectModel.test.ts` | P | P | — |
| `src/components/rateLimit.test.ts` | P | P | — |
| `src/components/resources/AttachControls.render.test.tsx` | P | P | — |
| `src/components/resources/attach.test.ts` | P | P | — |
| `src/components/resources/hostSelection.test.ts` | P | P | — |
| `src/components/retainedQueueAdmissions.dom.test.ts` | P | P | — |
| `src/components/reviewerAutoClose.test.ts` | P | P | — |
| `src/components/runtime/AttentionCard.dismiss.dom.test.tsx` | P | P | — |
| `src/components/runtime/AttentionCard.focus.dom.test.tsx` | P | P | — |
| `src/components/runtime/ConversationAttention.test.ts` | P | P | — |
| `src/components/runtime/DeadHostBanner.action.test.tsx` | P | P | — |
| `src/components/runtime/DeadHostBanner.copy.dom.test.tsx` | P | P | — |
| `src/components/runtime/DeadHostBanner.dom.test.tsx` | P | P | — |
| `src/components/runtime/McpCallCard.dom.test.tsx` | P | P | — |
| `src/components/runtime/SupersededBanner.dom.test.tsx` | P | P | — |
| `src/components/runtime/deliveryNotice.test.ts` | P | P | — |
| `src/components/runtime/deliveryState.test.ts` | P | P | — |
| `src/components/runtime/deliveryWait.dom.test.tsx` | P | P | — |
| `src/components/runtime/deliveryWait.test.ts` | P | P | — |
| `src/components/runtime/runtimeComponents.render.test.tsx` | P | P | — |
| `src/components/runtime/runtimeModel.test.ts` | P | P | — |
| `src/components/runtimeProfile.test.ts` | P | P | — |
| `src/components/scheme/AgentLinksLayer.render.test.tsx` | P | P | — |
| `src/components/scheme/EdgeChips.dom.test.tsx` | P | P | — |
| `src/components/scheme/EdgeChips.hover.dom.test.tsx` | P | P | — |
| `src/components/scheme/GroupOverridePanel.dom.test.tsx` | P | P | — |
| `src/components/scheme/GroupOverridePanel.render.test.tsx` | P | P | — |
| `src/components/scheme/GroupsLayer.render.test.tsx` | P | P | — |
| `src/components/scheme/Minimap.render.test.tsx` | P | P | — |
| `src/components/scheme/SchemeBoard.bands.dom.test.tsx` | F | P | C28 |
| `src/components/scheme/SchemeBoard.builderReveal.dom.test.tsx` | P | P | — |
| `src/components/scheme/SchemeBoard.camera.dom.test.tsx` | P | P | — |
| `src/components/scheme/SchemeBoard.catalogFocus.dom.test.tsx` | P | P | — |
| `src/components/scheme/SchemeBoard.lineage.dom.test.tsx` | F | P | C61 |
| `src/components/scheme/SchemeBoard.mapFraming.dom.test.tsx` | P | P | — |
| `src/components/scheme/SchemeBoard.mapStacks.dom.test.tsx` | P | P | — |
| `src/components/scheme/SchemeBoard.pipelineComposition.dom.test.tsx` | F | P | C62 |
| `src/components/scheme/SchemeBoard.pipelineRegions.dom.test.tsx` | F | P | C63 |
| `src/components/scheme/SchemeBoard.selection.dom.test.tsx` | P | P | — |
| `src/components/scheme/SchemeBoard.stageOverlay.dom.test.tsx` | F | P | C23 |
| `src/components/scheme/SchemeOverlay.strip.dom.test.tsx` | F | F | C46 |
| `src/components/scheme/SubagentBadgeAnchors.render.test.tsx` | P | P | — |
| `src/components/scheme/SubagentBadges.dom.test.tsx` | P | P | — |
| `src/components/scheme/SubagentTrayView.dom.test.tsx` | P | P | — |
| `src/components/scheme/TaskCard.dom.test.tsx` | P | P | — |
| `src/components/scheme/agentLinks.test.ts` | P | P | — |
| `src/components/scheme/assignmentState.test.ts` | P | P | — |
| `src/components/scheme/bulkActions.test.ts` | P | P | — |
| `src/components/scheme/canvasGrid.test.ts` | P | P | — |
| `src/components/scheme/currentWork.test.ts` | P | P | — |
| `src/components/scheme/directReviewBoardComposition.test.ts` | F | P | C64 |
| `src/components/scheme/expandedNode.test.ts` | P | P | — |
| `src/components/scheme/findFreeSlot.test.ts` | P | P | — |
| `src/components/scheme/focusFrames.test.ts` | P | P | — |
| `src/components/scheme/lasso.test.ts` | P | P | — |
| `src/components/scheme/layout.lineage.test.ts` | F | P | C65 |
| `src/components/scheme/layout.test.ts` | P | P | — |
| `src/components/scheme/lineageModel.test.ts` | P | P | — |
| `src/components/scheme/nodes.anatomy.render.test.tsx` | P | P | — |
| `src/components/scheme/nodes.dom.test.tsx` | F | F | C66 |
| `src/components/scheme/nodes.stageRow.dom.test.tsx` | F | F | C25 |
| `src/components/scheme/nodes.strip.dom.test.tsx` | F | F | C25 |
| `src/components/scheme/offscreenClusters.test.ts` | P | P | — |
| `src/components/scheme/pipelineAnchor.test.ts` | P | P | — |
| `src/components/scheme/pipelineRegionGeometry.test.ts` | P | P | — |
| `src/components/scheme/pipelineStageSurfaces.test.ts` | P | P | — |
| `src/components/scheme/placementHorizon.test.ts` | P | P | — |
| `src/components/scheme/renameRequest.test.ts` | P | P | — |
| `src/components/scheme/selectionGesture.test.ts` | P | P | — |
| `src/components/scheme/spatialNav.test.ts` | P | P | — |
| `src/components/scheme/subagentBadgeAnchors.test.ts` | P | P | — |
| `src/components/scheme/subagentBadgeLayout.test.ts` | P | P | — |
| `src/components/scheme/subagentBadgeModel.test.ts` | P | P | — |
| `src/components/scheme/subagentTray.test.ts` | P | P | — |
| `src/components/scheme/taskBands.test.ts` | P | P | — |
| `src/components/scheme/taskGeometry.test.ts` | P | P | — |
| `src/components/scheme/taskPlacement.test.ts` | P | P | — |
| `src/components/scheme/taskStacks.test.ts` | P | P | — |
| `src/components/scheme/useSchemeCamera.focus.dom.test.tsx` | P | P | — |
| `src/components/scheme/useSchemeCamera.test.ts` | P | P | — |
| `src/components/scheme/useSpatialNav.test.ts` | P | P | — |
| `src/components/scheme/workerCollapse.test.ts` | P | P | — |
| `src/components/search/GlobalSearch.dom.test.tsx` | P | P | — |
| `src/components/search/useTranscriptSearch.dom.test.tsx` | P | P | — |
| `src/components/search/useTranscriptSearch.test.ts` | P | P | — |
| `src/components/selfUpdate/SelfUpdateView.dom.test.tsx` | P | P | — |
| `src/components/session/SessionTitle.dom.test.tsx` | P | P | — |
| `src/components/session/SessionTitle.mobile.dom.test.tsx` | F | P | C23 |
| `src/components/skeletons.dom.test.tsx` | P | P | — |
| `src/components/taskAlbum/TaskAlbum.dom.test.tsx` | P | P | — |
| `src/components/tasks/TaskIcon.dom.test.tsx` | P | P | — |
| `src/components/tasks/TaskPanel.boardPreference.dom.test.tsx` | P | P | — |
| `src/components/tasks/TaskSheet.dom.test.tsx` | P | P | — |
| `src/components/tasks/TaskWorkflowPanel.dom.test.tsx` | P | P | — |
| `src/components/tasks/taskApi.test.ts` | P | P | — |
| `src/components/tasks/taskRelations.test.ts` | P | P | — |
| `src/components/tasks/taskWorkflowModel.test.ts` | P | P | — |
| `src/components/team/passkey.browser.test.ts` | G | G | — |
| `src/components/team/ui.test.ts` | P | P | — |
| `src/components/turnDuration.test.ts` | P | P | — |
| `src/components/utils.test.ts` | P | P | — |
| `src/components/voice/VoiceComposerHost.dom.test.tsx` | P | P | — |
| `src/components/voice/VoicePipHost.dom.test.tsx` | P | P | — |
| `src/components/voice/useDocumentPictureInPicture.dom.test.tsx` | P | P | — |
| `src/components/voice/viewerContextPrelude.test.ts` | P | P | — |
| `src/components/voice/voiceComposerPlaces.test.ts` | P | P | — |
| `src/components/workLinks/workLinks.dom.test.tsx` | F | P | C67 |
| `src/components/workflows/legacyDraftPurge.dom.test.tsx` | F | P | C30 |
| `src/components/workflows/workflowModel.test.ts` | P | P | — |
| `src/hooks/composerVoiceSend.test.ts` | P | P | — |
| `src/hooks/logBus.test.ts` | P | P | — |
| `src/hooks/logTailStore.test.ts` | P | P | — |
| `src/hooks/runtimeBus.dom.test.tsx` | P | P | — |
| `src/hooks/runtimeBus.test.ts` | P | P | — |
| `src/hooks/serverReach.dom.test.tsx` | P | P | — |
| `src/hooks/useAgentChimes.test.ts` | P | P | — |
| `src/hooks/useBoardState.convergence.test.ts` | P | P | — |
| `src/hooks/useBoardState.persisted.dom.test.ts` | P | P | — |
| `src/hooks/useBoardState.selection.test.ts` | P | P | — |
| `src/hooks/useBoardState.sharedStore.dom.test.tsx` | P | P | — |
| `src/hooks/useBoardState.test.ts` | P | P | — |
| `src/hooks/useBridgeReportRelay.dom.test.tsx` | P | P | — |
| `src/hooks/useCodexRealtime.ambient.dom.test.tsx` | P | P | — |
| `src/hooks/useCodexRealtime.voiceBodies.dom.test.tsx` | P | P | — |
| `src/hooks/useComposer.dictationInsert.dom.test.tsx` | P | P | — |
| `src/hooks/useComposer.keyboardCeiling.dom.test.tsx` | P | P | — |
| `src/hooks/useConversationCatalog.dom.test.tsx` | P | P | — |
| `src/hooks/useConversationCatalog.test.ts` | P | P | — |
| `src/hooks/useConversationControl.test.tsx` | P | P | — |
| `src/hooks/useEngineAccounts.test.ts` | P | P | — |
| `src/hooks/useFiles.catalogFailure.dom.test.tsx` | P | P | — |
| `src/hooks/useFiles.delta.test.ts` | P | P | — |
| `src/hooks/useFiles.dom.test.tsx` | P | P | — |
| `src/hooks/useFiles.forwardOnly.test.ts` | P | P | — |
| `src/hooks/useFiles.snapshot.dom.test.tsx` | P | P | — |
| `src/hooks/useFiles.spawnOverlay.test.ts` | P | P | — |
| `src/hooks/useFiles.stateWrites.dom.test.tsx` | P | P | — |
| `src/hooks/useFiles.test.ts` | P | P | — |
| `src/hooks/useFiles.visibility.dom.test.tsx` | P | P | — |
| `src/hooks/useIsMobile.dom.test.tsx` | P | P | — |
| `src/hooks/useLogTail.dom.test.tsx` | P | P | — |
| `src/hooks/useLogTail.reopen.dom.test.tsx` | P | P | — |
| `src/hooks/useNowSeconds.dom.test.tsx` | P | P | — |
| `src/hooks/useOverlayEscape.dom.test.tsx` | P | P | — |
| `src/hooks/useProjectCuration.dom.test.tsx` | P | P | — |
| `src/hooks/useProximity.test.ts` | P | P | — |
| `src/hooks/useRuntime.test.ts` | P | P | — |
| `src/hooks/useScreenWakeLock.test.ts` | P | P | — |
| `src/hooks/useSwitchboardData.dom.test.tsx` | P | P | — |
| `src/hooks/useTaskDraft.refusals.dom.test.tsx` | P | P | — |
| `src/hooks/useTelegramConnection.dom.test.tsx` | P | P | — |
| `src/hooks/useTelegramReports.dom.test.tsx` | P | P | — |
| `src/hooks/useViewPresence.test.ts` | P | P | — |
| `src/hooks/viewPresenceBus.selectedContext.test.ts` | P | P | — |
| `src/hooks/viewPresenceBus.test.ts` | P | P | — |
| `src/instrumentation.test.ts` | F | F | C68 |
| `src/lib/accounts/accountMutation.test.ts` | P | P | — |
| `src/lib/accounts/accountOverrides.test.ts` | P | P | — |
| `src/lib/accounts/accountsStore.legacyFile.test.ts` | P | P | — |
| `src/lib/accounts/accountsStore.sqlite.test.ts` | P | P | — |
| `src/lib/accounts/badge.test.ts` | P | P | — |
| `src/lib/accounts/claude.test.ts` | F | P | C10 |
| `src/lib/accounts/claudeCredentials.test.ts` | F | P | C69 |
| `src/lib/accounts/claudeLogin.test.ts` | P | P | — |
| `src/lib/accounts/claudeLoginIdentity.test.ts` | P | P | — |
| `src/lib/accounts/claudeOauth.test.ts` | P | P | — |
| `src/lib/accounts/claudeProvider.smoke.test.ts` | G | G | — |
| `src/lib/accounts/claudeProvider.test.ts` | F | F | C70 |
| `src/lib/accounts/claudeTranscriptOwnership.test.ts` | P | P | — |
| `src/lib/accounts/codex.loginReservation.test.ts` | P | P | — |
| `src/lib/accounts/codex.test.ts` | F | P | C10 |
| `src/lib/accounts/codexAppServer.test.ts` | P | P | — |
| `src/lib/accounts/codexAppServerProtocol.test.ts` | P | P | — |
| `src/lib/accounts/codexRuntime.test.ts` | P | P | — |
| `src/lib/accounts/codexServiceTiers.test.ts` | P | P | — |
| `src/lib/accounts/copilot.test.ts` | P | P | — |
| `src/lib/accounts/copilotLogin.test.ts` | P | P | — |
| `src/lib/accounts/engineConnection.test.ts` | P | P | — |
| `src/lib/accounts/headlessSelection.test.ts` | P | P | — |
| `src/lib/accounts/identity.test.ts` | P | P | — |
| `src/lib/accounts/manager.copilotSelection.test.ts` | P | P | — |
| `src/lib/accounts/manager.interprocess.test.ts` | F | P | C71 |
| `src/lib/accounts/managerProjectBinding.test.ts` | P | P | — |
| `src/lib/accounts/migration.test.ts` | P | P | — |
| `src/lib/accounts/migration/controller.performance.test.ts` | P | P | — |
| `src/lib/accounts/migration/controller.routing.test.ts` | P | P | — |
| `src/lib/accounts/migration/controller.test.ts` | P | P | — |
| `src/lib/accounts/migration/controllerScan.test.ts` | P | P | — |
| `src/lib/accounts/migration/controllerSignal.test.ts` | P | P | — |
| `src/lib/accounts/migration/coordinator.test.ts` | F | P | C11 |
| `src/lib/accounts/migration/coordinatorDeadTurn.test.ts` | P | P | — |
| `src/lib/accounts/migration/coordinatorNeverStarted.test.ts` | P | P | — |
| `src/lib/accounts/migration/coordinatorNoOpInventory.test.ts` | P | P | — |
| `src/lib/accounts/migration/intentLiveness.test.ts` | P | P | — |
| `src/lib/accounts/migration/provider.test.ts` | P | P | — |
| `src/lib/accounts/migration/quotaController.test.ts` | P | P | — |
| `src/lib/accounts/migration/quotaPolicy.test.ts` | P | P | — |
| `src/lib/accounts/migration/safeHistoryCopy.test.ts` | P | P | — |
| `src/lib/accounts/migration/turnState.test.ts` | P | P | — |
| `src/lib/accounts/projectAccountsView.test.ts` | P | P | — |
| `src/lib/accounts/projectBindings.interprocess.test.ts` | P | P | — |
| `src/lib/accounts/projectBindings.test.ts` | P | P | — |
| `src/lib/accounts/projectSelection.test.ts` | P | P | — |
| `src/lib/accounts/removal.test.ts` | F | P | C10 |
| `src/lib/accounts/reseat.test.ts` | P | P | — |
| `src/lib/accounts/reseatBinding.test.ts` | P | P | — |
| `src/lib/accounts/reseatCommandBinding.test.ts` | P | P | — |
| `src/lib/accounts/spawnHealth.test.ts` | P | P | — |
| `src/lib/accounts/terminalLaunch.test.ts` | P | P | — |
| `src/lib/activity/hostSources.test.ts` | P | P | — |
| `src/lib/activity/humanInput.test.ts` | P | P | — |
| `src/lib/activity/ingest.test.ts` | P | P | — |
| `src/lib/activity/method.test.ts` | P | P | — |
| `src/lib/activity/pull.test.ts` | P | P | — |
| `src/lib/activity/report.test.ts` | P | P | — |
| `src/lib/activity/requestLedger.test.ts` | P | P | — |
| `src/lib/activity/transcriptExport.test.ts` | P | P | — |
| `src/lib/agent/accountLiveness.test.ts` | P | P | — |
| `src/lib/agent/attachCommand.test.ts` | P | P | — |
| `src/lib/agent/cli.integration.test.ts` | G | G | — |
| `src/lib/agent/cli.test.ts` | F | F | C72 |
| `src/lib/agent/copilotModels.test.ts` | P | P | — |
| `src/lib/agent/efforts.test.ts` | P | P | — |
| `src/lib/agent/ephemeral.probe.test.ts` | G | G | — |
| `src/lib/agent/ephemeral.test.ts` | P | P | — |
| `src/lib/agent/failedSpawnDelivery.test.ts` | F | P | C73 |
| `src/lib/agent/identityWaveMigration.test.ts` | P | P | — |
| `src/lib/agent/mcpAllowlist.test.ts` | P | P | — |
| `src/lib/agent/migration.test.ts` | P | P | — |
| `src/lib/agent/models.test.ts` | P | P | — |
| `src/lib/agent/nestingPolicy.test.ts` | P | P | — |
| `src/lib/agent/operatorAuthority.test.ts` | F | P | C10 |
| `src/lib/agent/operatorCapability.test.ts` | P | P | — |
| `src/lib/agent/pluginAllowlist.test.ts` | P | P | — |
| `src/lib/agent/reconfigure.test.ts` | P | P | — |
| `src/lib/agent/registry.admission.test.ts` | P | P | — |
| `src/lib/agent/registry.backendResolution.test.ts` | P | P | — |
| `src/lib/agent/registry.deliveryRead.test.ts` | P | P | — |
| `src/lib/agent/registry.engineNative.test.ts` | P | P | — |
| `src/lib/agent/registry.migrationBinding.test.ts` | P | P | — |
| `src/lib/agent/registry.projectOwnership.test.ts` | P | P | — |
| `src/lib/agent/registry.reseat.test.ts` | P | P | — |
| `src/lib/agent/registry.sqlite.test.ts` | T | P | C74; five consecutive full-file runs 68/0, 369 assertions each; target case 0.82–1.41s; merged-head recheck 5×68/0, target case 0.670–0.918s |
| `src/lib/agent/registry.sqliteOnly.test.ts` | P | P | — |
| `src/lib/agent/registry.test.ts` | P | P | — |
| `src/lib/agent/registryBackendIdentity.test.ts` | P | P | — |
| `src/lib/agent/resumeEligibility.test.ts` | P | P | — |
| `src/lib/agent/sessionKey.test.ts` | P | P | — |
| `src/lib/agent/spawnAdmission.test.ts` | P | P | — |
| `src/lib/agent/spawnCommand.contention.test.ts` | P | P | — |
| `src/lib/agent/spawnCommand.locale.test.ts` | P | P | — |
| `src/lib/agent/spawnCommand.telegram.test.ts` | P | P | — |
| `src/lib/agent/spawnPolicy.test.ts` | P | P | — |
| `src/lib/agent/spawnProjection.test.ts` | P | P | — |
| `src/lib/agent/spawnedTranscript.test.ts` | P | P | — |
| `src/lib/agent/transcript.test.ts` | P | P | — |
| `src/lib/agent/transcriptHost.engineNative.test.ts` | P | P | — |
| `src/lib/agent/transcriptHost.test.ts` | P | P | — |
| `src/lib/answer/menu.test.ts` | P | P | — |
| `src/lib/artifact/classify.test.ts` | P | P | — |
| `src/lib/artifact/fragment.test.ts` | P | P | — |
| `src/lib/artifact/linkTarget.test.ts` | P | P | — |
| `src/lib/artifact/serve.test.ts` | P | P | — |
| `src/lib/asks/asksYou.test.ts` | P | P | — |
| `src/lib/asks/controller.test.ts` | P | P | — |
| `src/lib/asks/jev.test.ts` | P | P | — |
| `src/lib/asyncCoalescer.test.ts` | P | P | — |
| `src/lib/attention/callerAuthority.test.ts` | P | P | — |
| `src/lib/attention/dismissals.test.ts` | P | P | — |
| `src/lib/attention/eligibility.test.ts` | P | P | — |
| `src/lib/attention/landing.test.ts` | F | P | C75 |
| `src/lib/attention/machine.test.ts` | P | P | — |
| `src/lib/attention/readerArrival.test.ts` | P | P | — |
| `src/lib/attention/resolve.test.ts` | P | P | — |
| `src/lib/attention/service.test.ts` | P | P | — |
| `src/lib/attention/store.sqlite.test.ts` | P | P | — |
| `src/lib/attention/store.test.ts` | P | P | — |
| `src/lib/audio/ambientLoop.test.ts` | P | P | — |
| `src/lib/audio/app.test.ts` | P | P | — |
| `src/lib/audio/cuePlayer.test.ts` | P | P | — |
| `src/lib/audio/cues.test.ts` | P | P | — |
| `src/lib/audio/prefs.test.ts` | P | P | — |
| `src/lib/audio/toolCues.feed.test.ts` | P | P | — |
| `src/lib/audio/toolCues.test.ts` | P | P | — |
| `src/lib/audio/webAudioTransport.test.ts` | P | P | — |
| `src/lib/board/desktopBoard.test.ts` | P | P | — |
| `src/lib/board/keys.test.ts` | P | P | — |
| `src/lib/board/mutations.test.ts` | P | P | — |
| `src/lib/board/store.legacyFile.test.ts` | P | P | — |
| `src/lib/board/store.sqlite.test.ts` | F | P | C76 |
| `src/lib/board/store.test.ts` | P | P | — |
| `src/lib/board/validation.test.ts` | P | P | — |
| `src/lib/boardMaintenance/answer.test.ts` | P | P | — |
| `src/lib/boardMaintenance/evidence.test.ts` | P | P | — |
| `src/lib/boardMaintenance/guard.test.ts` | P | P | — |
| `src/lib/boardMaintenance/run.test.ts` | P | P | — |
| `src/lib/boardMaintenance/store.test.ts` | P | P | — |
| `src/lib/boardMaintenance/text.test.ts` | P | P | — |
| `src/lib/boardMaintenance/wake.test.ts` | P | P | — |
| `src/lib/bridge/asks.test.ts` | P | P | — |
| `src/lib/bridge/directive.test.ts` | P | P | — |
| `src/lib/bridge/gatewayAuthority.test.ts` | P | P | — |
| `src/lib/bridge/pendingAcknowledgements.test.ts` | P | P | — |
| `src/lib/bridge/publicSafe.test.ts` | P | P | — |
| `src/lib/bridge/recovery.test.ts` | P | P | — |
| `src/lib/bridge/reportLog.test.ts` | P | P | — |
| `src/lib/bridge/reportRender.test.ts` | P | P | — |
| `src/lib/bridge/routing.test.ts` | F | P | C10 |
| `src/lib/bridge/scoping.test.ts` | P | P | — |
| `src/lib/bridge/service.test.ts` | P | P | — |
| `src/lib/bridge/store.sqlite.test.ts` | P | P | — |
| `src/lib/bridge/store.test.ts` | P | P | — |
| `src/lib/bridge/taskChanges.test.ts` | P | P | — |
| `src/lib/bridge/telegramReport.test.ts` | P | P | — |
| `src/lib/burndown.test.ts` | P | P | — |
| `src/lib/chime.test.ts` | P | P | — |
| `src/lib/client/hiddenTraffic.test.ts` | P | P | — |
| `src/lib/client/runtimeFilesStatus.test.ts` | P | P | — |
| `src/lib/codexHeadlessConfig.test.ts` | P | P | — |
| `src/lib/composerScroll.test.ts` | P | P | — |
| `src/lib/composerSubmissionPayloads.dom.test.ts` | P | P | — |
| `src/lib/configDir.staging.test.ts` | P | P | — |
| `src/lib/configDir.test.ts` | P | P | — |
| `src/lib/conversation/actions.test.ts` | P | P | — |
| `src/lib/conversation/resumeLiveness.test.ts` | P | P | — |
| `src/lib/conversation/terminalBornResume.test.ts` | P | P | — |
| `src/lib/deadline.test.ts` | P | P | — |
| `src/lib/delivery.test.ts` | P | P | — |
| `src/lib/deliveryActuation.test.ts` | P | P | — |
| `src/lib/deliveryInterrupt.test.ts` | P | P | — |
| `src/lib/deliveryPaneBufferError.test.ts` | P | P | — |
| `src/lib/dictationTimer.test.ts` | P | P | — |
| `src/lib/displayNames.test.ts` | P | P | — |
| `src/lib/environmentIsolation.test.ts` | P | P | — |
| `src/lib/externalRelay/client.test.ts` | P | P | — |
| `src/lib/externalRelay/knownRelays.test.ts` | P | P | — |
| `src/lib/externalRelay/poller.test.ts` | P | P | — |
| `src/lib/externalRelay/progress.test.ts` | P | P | — |
| `src/lib/externalRelay/protocol.test.ts` | P | P | — |
| `src/lib/externalRelay/runner.test.ts` | P | P | — |
| `src/lib/externalRelay/store.test.ts` | P | P | — |
| `src/lib/filesDelta.test.ts` | P | P | — |
| `src/lib/filesReadSummary.test.ts` | P | P | — |
| `src/lib/flows/commands.durable.test.ts` | P | P | — |
| `src/lib/flows/commands.set-roles.test.ts` | P | P | — |
| `src/lib/flows/commands.test.ts` | P | P | — |
| `src/lib/flows/decisions.test.ts` | P | P | — |
| `src/lib/flows/engine.test.ts` | P | P | — |
| `src/lib/flows/exec.test.ts` | P | P | — |
| `src/lib/flows/findings.test.ts` | P | P | — |
| `src/lib/flows/git.test.ts` | P | P | — |
| `src/lib/flows/prompts.test.ts` | P | P | — |
| `src/lib/flows/relayProvenance.test.ts` | P | P | — |
| `src/lib/flows/relayResumeAccount.test.ts` | P | P | — |
| `src/lib/flows/reviewOutcome.test.ts` | P | P | — |
| `src/lib/flows/reviewerPolicy.test.ts` | P | P | — |
| `src/lib/flows/store-isolation.test.ts` | P | P | — |
| `src/lib/flows/store.test.ts` | P | P | — |
| `src/lib/flows/visibility.test.ts` | P | P | — |
| `src/lib/forge/autoMerge.test.ts` | P | P | — |
| `src/lib/forge/autoMergeStore.test.ts` | P | P | — |
| `src/lib/forge/checkRollup.test.ts` | P | P | — |
| `src/lib/forge/sweep.test.ts` | P | P | — |
| `src/lib/forge/taskFinish.test.ts` | P | P | — |
| `src/lib/forge/workLinks.test.ts` | P | P | — |
| `src/lib/git/agentPublicationIdentity.test.ts` | P | P | — |
| `src/lib/git/codexShellPolicy.test.ts` | P | P | — |
| `src/lib/git/transientFailure.test.ts` | P | P | — |
| `src/lib/headlessProcessReaper.test.ts` | P | P | — |
| `src/lib/http/gzipBody.test.ts` | P | P | — |
| `src/lib/i18n/formatters.test.ts` | P | P | — |
| `src/lib/i18n/i18n.test.ts` | P | P | — |
| `src/lib/i18n/operatorLocaleSync.dom.test.ts` | P | P | — |
| `src/lib/i18n/proseLanguage.test.ts` | P | P | — |
| `src/lib/i18n/serverBoundary.test.ts` | P | P | — |
| `src/lib/i18n/spawnCopy.test.ts` | P | P | — |
| `src/lib/inboxFiles.test.ts` | P | P | — |
| `src/lib/lifecycle/digest.test.ts` | P | P | — |
| `src/lib/lifecycle/inventorySelection.test.ts` | P | P | — |
| `src/lib/lifecycle/journal.test.ts` | P | P | — |
| `src/lib/lifecycle/liveness.test.ts` | P | P | — |
| `src/lib/lifecycle/projector.test.ts` | P | P | — |
| `src/lib/limitWindows.test.ts` | P | P | — |
| `src/lib/limits.test.ts` | P | P | — |
| `src/lib/limits/copilotQuota.test.ts` | P | P | — |
| `src/lib/limits/copilotTranscriptLimits.test.ts` | P | P | — |
| `src/lib/limitsBurndown.test.ts` | P | P | — |
| `src/lib/limitsHistoryStore.test.ts` | P | P | — |
| `src/lib/links/agentFeed.test.ts` | P | P | — |
| `src/lib/links/boardSync.test.ts` | T | T | C77 |
| `src/lib/links/bootAdoption.test.ts` | P | P | — |
| `src/lib/links/hostStartCoverage.test.ts` | P | P | — |
| `src/lib/links/laneFeed.test.ts` | P | P | — |
| `src/lib/links/pairing.test.ts` | P | P | — |
| `src/lib/links/protocol.test.ts` | P | P | — |
| `src/lib/links/removeRace.test.ts` | P | P | — |
| `src/lib/links/runtimeState.test.ts` | P | P | — |
| `src/lib/links/schedule.test.ts` | P | P | — |
| `src/lib/links/self.test.ts` | P | P | — |
| `src/lib/links/taskSync.test.ts` | F | P | C78 |
| `src/lib/logTailStream.test.ts` | P | P | — |
| `src/lib/mcp/accountProjectBinding.test.ts` | P | P | — |
| `src/lib/mcp/answerSizes.test.ts` | P | P | — |
| `src/lib/mcp/autoUpdates.test.ts` | P | P | — |
| `src/lib/mcp/bindings.test.ts` | F | F | C79 |
| `src/lib/mcp/bridgeDirective.test.ts` | P | P | — |
| `src/lib/mcp/bridgeReportOrigin.test.ts` | P | P | — |
| `src/lib/mcp/bridgeReportShape.test.ts` | P | P | — |
| `src/lib/mcp/callCost.test.ts` | P | P | — |
| `src/lib/mcp/compactAnswers.test.ts` | P | P | — |
| `src/lib/mcp/controlEndpoint.test.ts` | P | P | — |
| `src/lib/mcp/controlPlaneReads.test.ts` | F | P | C80 |
| `src/lib/mcp/conversationAction.integration.test.ts` | F | P | C81 |
| `src/lib/mcp/conversationMigration.integration.test.ts` | P | P | — |
| `src/lib/mcp/deployAuthority.test.ts` | P | P | — |
| `src/lib/mcp/deploymentReads.test.ts` | P | P | — |
| `src/lib/mcp/deputyAttribution.test.ts` | P | P | — |
| `src/lib/mcp/dismissAttention.test.ts` | F | P | C82 |
| `src/lib/mcp/healthProbeAdmission.test.ts` | P | P | — |
| `src/lib/mcp/http.test.ts` | P | P | — |
| `src/lib/mcp/maintainerGuard.integration.test.ts` | F | P | C83 |
| `src/lib/mcp/managerAuthority.test.ts` | P | P | — |
| `src/lib/mcp/managerLifecycleSeams.test.ts` | P | P | — |
| `src/lib/mcp/nativeWorkMetadata.test.ts` | P | P | — |
| `src/lib/mcp/orchestratorSendRecovery.test.ts` | P | P | — |
| `src/lib/mcp/orchestratorTools.test.ts` | P | P | — |
| `src/lib/mcp/originalKeySendRecovery.test.ts` | P | P | — |
| `src/lib/mcp/ownedFixtureChildren.test.ts` | P | P | — |
| `src/lib/mcp/pipelineBusyAdmission.test.ts` | P | P | — |
| `src/lib/mcp/presentation.test.ts` | P | P | — |
| `src/lib/mcp/readLatency.test.ts` | P | P | — |
| `src/lib/mcp/reportTools.test.ts` | F | P | C84 |
| `src/lib/mcp/requestAttention.immediate.test.ts` | P | P | — |
| `src/lib/mcp/requestAttention.targets.test.ts` | F | P | C10 |
| `src/lib/mcp/requestAttention.test.ts` | P | P | — |
| `src/lib/mcp/retirementStatus.integration.test.ts` | F | F | C85 |
| `src/lib/mcp/retirementStatus.test.ts` | F | F | C86 |
| `src/lib/mcp/retryStageLaunch.integration.test.ts` | F | P | C87 |
| `src/lib/mcp/rolePresets.test.ts` | P | P | — |
| `src/lib/mcp/schemaParity.test.ts` | P | P | — |
| `src/lib/mcp/searchMemory.budget.test.ts` | P | P | — |
| `src/lib/mcp/searchMemory.test.ts` | P | P | — |
| `src/lib/mcp/searchTranscripts.test.ts` | P | P | — |
| `src/lib/mcp/seatAnswerBudgets.test.ts` | P | P | — |
| `src/lib/mcp/selectedContextActions.test.ts` | P | P | — |
| `src/lib/mcp/server.test.ts` | P | P | — |
| `src/lib/mcp/spawnRecovery.integration.test.ts` | P | P | — |
| `src/lib/mcp/stdio.integration.test.ts` | F | F | C85 |
| `src/lib/mcp/suggestReplies.test.ts` | P | P | — |
| `src/lib/mcp/taskBoardVisibility.integration.test.ts` | P | P | — |
| `src/lib/mcp/taskColor.integration.test.ts` | P | P | — |
| `src/lib/mcp/taskColorGroupHide.integration.test.ts` | P | P | — |
| `src/lib/mcp/taskDetails.integration.test.ts` | P | P | — |
| `src/lib/mcp/taskIcon.integration.test.ts` | P | P | — |
| `src/lib/mcp/taskLineEdits.integration.test.ts` | P | P | — |
| `src/lib/mcp/taskOwnership.integration.test.ts` | P | P | — |
| `src/lib/mcp/taskPosition.integration.test.ts` | P | P | — |
| `src/lib/mcp/taskPriority.integration.test.ts` | P | P | — |
| `src/lib/mcp/telegramBot.test.ts` | P | P | — |
| `src/lib/mcp/toolAllowlist.service.test.ts` | P | P | — |
| `src/lib/mcp/toolAllowlist.test.ts` | P | P | — |
| `src/lib/mcp/voiceUtteranceContext.test.ts` | F | F | C88 |
| `src/lib/mcp/voiceUtteranceWiring.test.ts` | P | P | — |
| `src/lib/mcp/workLinks.test.ts` | P | P | — |
| `src/lib/mcp/writerConcurrency.test.ts` | F | P | C89 |
| `src/lib/memory/index.test.ts` | P | P | — |
| `src/lib/memory/service.test.ts` | P | P | — |
| `src/lib/memory/sources.test.ts` | P | P | — |
| `src/lib/monitor/cards.test.ts` | P | P | — |
| `src/lib/monitor/childFinalMessage.test.ts` | P | P | — |
| `src/lib/monitor/classify.test.ts` | P | P | — |
| `src/lib/monitor/evidence.test.ts` | P | P | — |
| `src/lib/monitor/githubEvidence.test.ts` | P | P | — |
| `src/lib/monitor/journalStore.test.ts` | P | P | — |
| `src/lib/monitor/redact.test.ts` | P | P | — |
| `src/lib/monitor/report.test.ts` | P | P | — |
| `src/lib/monitor/requests.test.ts` | P | P | — |
| `src/lib/monitor/seatMcpHealth.test.ts` | P | P | — |
| `src/lib/monitor/seatTick.test.ts` | P | P | — |
| `src/lib/monitor/seatTickAccounting.test.ts` | P | P | — |
| `src/lib/monitor/seatTickChildLedger.test.ts` | P | P | — |
| `src/lib/monitor/seatTickController.test.ts` | F | F | C90 |
| `src/lib/monitor/seatTickFence.test.ts` | P | P | — |
| `src/lib/monitor/seatTickRefusal.test.ts` | P | P | — |
| `src/lib/monitor/seatTickReports.test.ts` | P | P | — |
| `src/lib/monitor/seatTickSettings.sqlite.test.ts` | P | P | — |
| `src/lib/monitor/seatTickSettings.test.ts` | P | P | — |
| `src/lib/monitor/seatTickSources.test.ts` | F | F | C90 |
| `src/lib/monitor/seatTickState.test.ts` | P | P | — |
| `src/lib/navigation/focusHistory.dom.test.ts` | P | P | — |
| `src/lib/navigation/focusHistory.test.ts` | P | P | — |
| `src/lib/navigation/fragmentNavigation.test.ts` | P | P | — |
| `src/lib/navigation/questionPushServiceWorker.test.ts` | P | P | — |
| `src/lib/onboarding/healthCheck.test.ts` | P | P | — |
| `src/lib/onboarding/healthRoute.test.ts` | P | P | — |
| `src/lib/onboarding/marker.test.ts` | P | P | — |
| `src/lib/operator/settings.test.ts` | P | P | — |
| `src/lib/operatorKeyEmission.test.ts` | P | P | — |
| `src/lib/orchestrator/authority.test.ts` | P | P | — |
| `src/lib/orchestrator/boardReport.test.ts` | P | P | — |
| `src/lib/orchestrator/boardReportRun.test.ts` | P | P | — |
| `src/lib/orchestrator/deputies.test.ts` | P | P | — |
| `src/lib/orchestrator/deputyCommand.test.ts` | P | P | — |
| `src/lib/orchestrator/deputySweep.test.ts` | P | P | — |
| `src/lib/orchestrator/handoffDigest.test.ts` | F | F | C91 |
| `src/lib/orchestrator/health.test.ts` | P | P | — |
| `src/lib/orchestrator/prompt.test.ts` | P | P | — |
| `src/lib/orchestrator/relay.test.ts` | P | P | — |
| `src/lib/orchestrator/rotationAccountChoice.test.ts` | P | P | — |
| `src/lib/orchestrator/rotationAuthority.test.ts` | P | P | — |
| `src/lib/orchestrator/rotationSettlement.test.ts` | P | P | — |
| `src/lib/orchestrator/seatCommand.test.ts` | P | P | — |
| `src/lib/orchestrator/seatDeployments.test.ts` | P | P | — |
| `src/lib/orchestrator/seatProjectIdentity.test.ts` | P | P | — |
| `src/lib/orchestrator/seats.test.ts` | P | P | — |
| `src/lib/overlay.test.ts` | P | P | — |
| `src/lib/pipelines/backgroundTaskSettlement.test.ts` | F | F | C92 |
| `src/lib/pipelines/backgroundTasks.test.ts` | P | P | — |
| `src/lib/pipelines/controller.test.ts` | P | P | — |
| `src/lib/pipelines/controllerArtifacts.test.ts` | P | P | — |
| `src/lib/pipelines/controllerSignal.test.ts` | P | P | — |
| `src/lib/pipelines/decisionAuthority.test.ts` | P | P | — |
| `src/lib/pipelines/deputyLineage.test.ts` | P | P | — |
| `src/lib/pipelines/durableEvidence.test.ts` | P | P | — |
| `src/lib/pipelines/engine.test.ts` | P | P | — |
| `src/lib/pipelines/engineConnectionRefusal.test.ts` | P | P | — |
| `src/lib/pipelines/failEdgeBudget.test.ts` | P | P | — |
| `src/lib/pipelines/git.test.ts` | P | P | — |
| `src/lib/pipelines/graphEdits.test.ts` | P | P | — |
| `src/lib/pipelines/legacyReviewConversion.test.ts` | F | P | C93 |
| `src/lib/pipelines/legacyReviewDefinition.test.ts` | P | P | — |
| `src/lib/pipelines/legacyReviewStore.test.ts` | P | P | — |
| `src/lib/pipelines/listProjection.test.ts` | P | P | — |
| `src/lib/pipelines/preflight.test.ts` | P | P | — |
| `src/lib/pipelines/prompts.test.ts` | P | P | — |
| `src/lib/pipelines/providerConditions.test.ts` | P | P | — |
| `src/lib/pipelines/registryCompatibility.test.ts` | P | P | — |
| `src/lib/pipelines/resolveDecision.test.ts` | P | P | — |
| `src/lib/pipelines/roles.test.ts` | F | P | C16 |
| `src/lib/pipelines/severedStageRetry.test.ts` | F | F | C94 |
| `src/lib/pipelines/severedTurnResume.test.ts` | P | P | — |
| `src/lib/pipelines/stageAccountBinding.test.ts` | P | P | — |
| `src/lib/pipelines/stageCompletion.test.ts` | F | F | C95 |
| `src/lib/pipelines/stageDigest.test.ts` | P | P | — |
| `src/lib/pipelines/stageHostGenerationClose.integration.test.ts` | F | F | C96 |
| `src/lib/pipelines/stageHostLiveness.test.ts` | P | P | — |
| `src/lib/pipelines/stageHostTeardown.test.ts` | P | P | — |
| `src/lib/pipelines/stageInput.restricted.probe.test.ts` | G | G | — |
| `src/lib/pipelines/stageInput.test.ts` | F | F | C97 |
| `src/lib/pipelines/stageProvenance.test.ts` | P | P | — |
| `src/lib/pipelines/stageSizing.test.ts` | P | P | — |
| `src/lib/pipelines/stageVerdictRequest.test.ts` | F | P | C98 |
| `src/lib/pipelines/store.test.ts` | P | P | — |
| `src/lib/pipelines/taskBinding.test.ts` | P | P | — |
| `src/lib/pipelines/taskFinish.test.ts` | P | P | — |
| `src/lib/pipelines/terminalReap.test.ts` | P | P | — |
| `src/lib/pipelines/verdict.test.ts` | P | P | — |
| `src/lib/pipelines/visibility.test.ts` | P | P | — |
| `src/lib/pipelines/worktreeSweep.test.ts` | P | P | — |
| `src/lib/platformHome.test.ts` | P | P | — |
| `src/lib/proc/darwinArgv.test.ts` | P | P | — |
| `src/lib/proc/darwinIdentity.test.ts` | P | P | — |
| `src/lib/proc/index.test.ts` | P | P | — |
| `src/lib/proc/memory.test.ts` | P | P | — |
| `src/lib/proc/portable.test.ts` | P | P | — |
| `src/lib/proc/windows.test.ts` | P | P | — |
| `src/lib/proc/windowsCwd.test.ts` | P | P | — |
| `src/lib/proc/windowsIdentity.test.ts` | P | P | — |
| `src/lib/proc/windowsSnapshot.test.ts` | P | P | — |
| `src/lib/processGroup.test.ts` | P | P | — |
| `src/lib/processIdentity.test.ts` | P | P | — |
| `src/lib/projects/aliases.test.ts` | P | P | — |
| `src/lib/projects/clientAliases.test.ts` | P | P | — |
| `src/lib/projects/curation.test.ts` | P | P | — |
| `src/lib/projects/directorySuggestions.test.ts` | P | P | — |
| `src/lib/projects/durableMigration.test.ts` | P | P | — |
| `src/lib/projects/identity.test.ts` | P | P | — |
| `src/lib/projects/reportDestination.test.ts` | P | P | — |
| `src/lib/projects/succession.test.ts` | P | P | — |
| `src/lib/projects/suggestionRoots.test.ts` | P | P | — |
| `src/lib/proxyBodySize.test.ts` | P | P | — |
| `src/lib/rateLimit.test.ts` | P | P | — |
| `src/lib/realtime/codexRealtimeClient.selectedContext.dom.test.ts` | P | P | — |
| `src/lib/realtime/codexRealtimeClient.test.ts` | P | P | — |
| `src/lib/realtime/codexRealtimeClient.transport.dom.test.ts` | P | P | — |
| `src/lib/realtime/codexRealtimeClient.transport.dom.test.tsx` | P | P | — |
| `src/lib/realtime/selectedContextBinding.test.ts` | P | P | — |
| `src/lib/realtime/voiceCanonicalTranscript.dom.test.ts` | P | P | — |
| `src/lib/realtime/voiceCardChain.dom.test.ts` | P | P | — |
| `src/lib/reaper.test.ts` | P | P | — |
| `src/lib/reaperAuthorship.test.ts` | P | P | — |
| `src/lib/reaperRuntime.performance.test.ts` | P | P | — |
| `src/lib/reaperRuntime.test.ts` | F | F | C99 |
| `src/lib/reconfigureBinding.test.ts` | P | P | — |
| `src/lib/resourceCollector.test.ts` | P | P | — |
| `src/lib/resourceViewerTree.test.ts` | P | P | — |
| `src/lib/resources.structuredHosts.test.ts` | P | P | — |
| `src/lib/resources.test.ts` | F | P | C100 |
| `src/lib/resources.truth.test.ts` | P | P | — |
| `src/lib/resumePanesFile.test.ts` | P | P | — |
| `src/lib/review.test.ts` | P | P | — |
| `src/lib/review/extraction.test.ts` | F | P | C101 |
| `src/lib/review/reviewOutcome.test.ts` | P | P | — |
| `src/lib/reviewHistory/reader.test.ts` | F | P | C102 |
| `src/lib/reviewHistory/relayIdentity.test.ts` | P | P | — |
| `src/lib/roleFrames.test.ts` | P | P | — |
| `src/lib/roles/costHints.test.ts` | P | P | — |
| `src/lib/roles/equivalents.test.ts` | P | P | — |
| `src/lib/roles/parameters.test.ts` | P | P | — |
| `src/lib/roles/registry.test.ts` | P | P | — |
| `src/lib/roles/sizing.test.ts` | P | P | — |
| `src/lib/roles/store.test.ts` | P | P | — |
| `src/lib/root/adopt.test.ts` | P | P | — |
| `src/lib/root/lineage.test.ts` | P | P | — |
| `src/lib/root/store.test.ts` | P | P | — |
| `src/lib/runtime/accountPark.test.ts` | P | P | — |
| `src/lib/runtime/admittedMessageText.test.ts` | P | P | — |
| `src/lib/runtime/agentConfigSandbox.test.ts` | P | P | — |
| `src/lib/runtime/agentMemory.scope.test.ts` | G | G | — |
| `src/lib/runtime/agentMemory.test.ts` | P | P | — |
| `src/lib/runtime/agentPublicationIdentity.test.ts` | P | P | — |
| `src/lib/runtime/bridgeDelivery.test.ts` | P | P | — |
| `src/lib/runtime/claudeMessageProvenance.test.ts` | P | P | — |
| `src/lib/runtime/claudeProviderRelay.test.ts` | P | P | — |
| `src/lib/runtime/claudeStreamBrokerHost.compact.test.ts` | P | P | — |
| `src/lib/runtime/claudeStreamBrokerHost.integration.test.ts` | G | G | — |
| `src/lib/runtime/claudeStreamBrokerHost.test.ts` | P | P | — |
| `src/lib/runtime/client.test.ts` | P | P | — |
| `src/lib/runtime/codex.test.ts` | P | P | — |
| `src/lib/runtime/codexAppServerHost.compact.test.ts` | P | P | — |
| `src/lib/runtime/codexAppServerHost.inject.test.ts` | P | P | — |
| `src/lib/runtime/codexAppServerHost.injectCli.test.ts` | P | P | — |
| `src/lib/runtime/codexAppServerHost.injectResponses.test.ts` | P | P | — |
| `src/lib/runtime/codexAppServerHost.integration.test.ts` | G | G | — |
| `src/lib/runtime/codexAppServerHost.pluginGrant.test.ts` | P | P | — |
| `src/lib/runtime/codexAppServerHost.test.ts` | P | P | — |
| `src/lib/runtime/codexHistoryReader.test.ts` | P | P | — |
| `src/lib/runtime/codexImageFrames.test.ts` | P | P | — |
| `src/lib/runtime/codexRealtimeTranscript.test.ts` | P | P | — |
| `src/lib/runtime/codexSteerDelivery.integration.test.ts` | G | G | — |
| `src/lib/runtime/codexStructuredUserText.compact.test.ts` | P | P | — |
| `src/lib/runtime/codexStructuredUserText.test.ts` | P | P | — |
| `src/lib/runtime/codexTurnProfile.test.ts` | P | P | — |
| `src/lib/runtime/commands.inject.test.ts` | P | P | — |
| `src/lib/runtime/commands.test.ts` | P | P | — |
| `src/lib/runtime/compactControl.test.ts` | P | P | — |
| `src/lib/runtime/composerPayloadRetry.integration.test.ts` | P | P | — |
| `src/lib/runtime/consumers.test.ts` | P | P | — |
| `src/lib/runtime/copilotAcpHost.integration.test.ts` | G | G | — |
| `src/lib/runtime/copilotAcpHost.test.ts` | P | P | — |
| `src/lib/runtime/deliveredMessageOccurrences.test.ts` | P | P | — |
| `src/lib/runtime/deliveryDedup.test.ts` | P | P | — |
| `src/lib/runtime/deploymentLedger.test.ts` | F | P | C103 |
| `src/lib/runtime/engineHostEvents.test.ts` | P | P | — |
| `src/lib/runtime/eventStore.test.ts` | P | P | — |
| `src/lib/runtime/filesRevision.test.ts` | P | P | — |
| `src/lib/runtime/flags.test.ts` | P | P | — |
| `src/lib/runtime/handoffQueue.test.ts` | P | P | — |
| `src/lib/runtime/handoffQueueStore.test.ts` | P | P | — |
| `src/lib/runtime/hostActivityFlags.test.ts` | P | P | — |
| `src/lib/runtime/http.activityLedger.test.ts` | P | P | — |
| `src/lib/runtime/http.admissionLookup.test.ts` | P | P | — |
| `src/lib/runtime/http.attachments.test.ts` | P | P | — |
| `src/lib/runtime/http.inject.test.ts` | P | P | — |
| `src/lib/runtime/http.refusedDelivery.test.ts` | P | P | — |
| `src/lib/runtime/http.team.test.ts` | P | P | — |
| `src/lib/runtime/http.test.ts` | P | P | — |
| `src/lib/runtime/inboxWriters.integration.test.ts` | P | P | — |
| `src/lib/runtime/interruptionObligations.test.ts` | P | P | — |
| `src/lib/runtime/legacyClaudeRecovery.cleanCi.integration.test.ts` | F | P | C104 |
| `src/lib/runtime/liveTurn.test.ts` | P | P | — |
| `src/lib/runtime/liveTurnControlPlane.test.ts` | P | P | — |
| `src/lib/runtime/liveness.test.ts` | P | P | — |
| `src/lib/runtime/livenessProjection.test.ts` | P | P | — |
| `src/lib/runtime/localEndpoint.test.ts` | P | P | — |
| `src/lib/runtime/lostTerminalAcknowledgement.test.ts` | P | P | — |
| `src/lib/runtime/messageTextDigest.test.ts` | P | P | — |
| `src/lib/runtime/nativeCodexQueue.test.ts` | P | P | — |
| `src/lib/runtime/nativeQueueCompaction.integration.test.ts` | P | P | — |
| `src/lib/runtime/nativeQueueContent.test.ts` | P | P | — |
| `src/lib/runtime/nativeQueueHost.integration.test.ts` | G | G | — |
| `src/lib/runtime/nativeQueueHttp.files.test.ts` | P | P | — |
| `src/lib/runtime/nativeQueueHttp.team.test.ts` | P | P | — |
| `src/lib/runtime/nativeQueueRuntime.test.ts` | P | P | — |
| `src/lib/runtime/permissionGuard.test.ts` | P | P | — |
| `src/lib/runtime/pipelineStageHostAccess.integration.test.ts` | F | G | C105 |
| `src/lib/runtime/realtimeControl.selectedContext.test.ts` | P | P | — |
| `src/lib/runtime/realtimeInjection.test.ts` | P | P | — |
| `src/lib/runtime/registryPersistence.test.ts` | P | P | — |
| `src/lib/runtime/releaseInterruption.test.ts` | P | P | — |
| `src/lib/runtime/runtimeImageAdmission.test.ts` | P | P | — |
| `src/lib/runtime/runtimeImageStore.test.ts` | P | P | — |
| `src/lib/runtime/selectedContextAdmission.test.ts` | P | P | — |
| `src/lib/runtime/sendSettlement.test.ts` | P | P | — |
| `src/lib/runtime/serverConsumers.test.ts` | P | P | — |
| `src/lib/runtime/severedHostReap.test.ts` | F | P | C106 |
| `src/lib/runtime/spawnTransport.test.ts` | P | P | — |
| `src/lib/runtime/sse.test.ts` | P | P | — |
| `src/lib/runtime/startup.test.ts` | F | F | C107 |
| `src/lib/runtime/startupFinalization.integration.test.ts` | P | P | — |
| `src/lib/runtime/startupStatus.test.ts` | P | P | — |
| `src/lib/runtime/structuredAccountIntent.test.ts` | P | P | — |
| `src/lib/runtime/structuredAccountSwitch.test.ts` | F | P | C108 |
| `src/lib/runtime/structuredCompactDelivery.test.ts` | P | P | — |
| `src/lib/runtime/structuredControls.test.ts` | P | P | — |
| `src/lib/runtime/structuredDelivery.integration.test.ts` | F | P | C109 |
| `src/lib/runtime/structuredDeliveryController.migration.test.ts` | P | P | — |
| `src/lib/runtime/structuredDeliveryController.test.ts` | P | P | — |
| `src/lib/runtime/structuredDeliveryLegacyVerdict.integration.test.ts` | P | P | — |
| `src/lib/runtime/structuredDeliveryQueue.copilot.test.ts` | P | P | — |
| `src/lib/runtime/structuredDeliveryQueue.inject.test.ts` | P | P | — |
| `src/lib/runtime/structuredDeliveryQueue.recoveryContention.test.ts` | F | F | C110 |
| `src/lib/runtime/structuredDeliveryQueue.test.ts` | P | P | — |
| `src/lib/runtime/structuredDeliveryRebind.test.ts` | F | P | C109 |
| `src/lib/runtime/structuredDeliverySignal.test.ts` | P | P | — |
| `src/lib/runtime/structuredFirstMessage.test.ts` | P | P | — |
| `src/lib/runtime/structuredHostAccess.test.ts` | P | P | — |
| `src/lib/runtime/structuredHostControl.test.ts` | P | P | — |
| `src/lib/runtime/structuredHostRetirement.test.ts` | P | P | — |
| `src/lib/runtime/structuredHostRetirementStatus.test.ts` | F | P | C111 |
| `src/lib/runtime/structuredMessageDelivery.accountReseat.test.ts` | P | P | — |
| `src/lib/runtime/structuredMessageDelivery.keyed.test.ts` | F | F | C112 |
| `src/lib/runtime/structuredMessageDelivery.placement.test.ts` | P | P | — |
| `src/lib/runtime/structuredMessageDelivery.sqlite.test.ts` | P | P | — |
| `src/lib/runtime/structuredMessageDelivery.test.ts` | P | P | — |
| `src/lib/runtime/structuredReconfigure.test.ts` | P | P | — |
| `src/lib/runtime/structuredRecovery.test.ts` | P | P | — |
| `src/lib/runtime/structuredRecoveryBinding.test.ts` | P | P | — |
| `src/lib/runtime/structuredSpawn.integration.test.ts` | P | P | — |
| `src/lib/runtime/structuredSpawn.terminalize.test.ts` | P | P | — |
| `src/lib/runtime/structuredSwitchCancel.test.ts` | F | P | C113 |
| `src/lib/runtime/structuredSwitchCancelQueue.test.ts` | P | P | — |
| `src/lib/runtime/structuredSwitchCommitMessages.test.ts` | P | P | — |
| `src/lib/runtime/submissionIdentity.test.ts` | P | P | — |
| `src/lib/runtime/voiceBodyProjection.test.ts` | P | P | — |
| `src/lib/runtime/voiceDelivery.test.ts` | P | P | — |
| `src/lib/runtime/voicePersona.test.ts` | P | P | — |
| `src/lib/runtime/voicePersonaMandate.test.ts` | P | P | — |
| `src/lib/runtime/voicePersonaRole.test.ts` | P | P | — |
| `src/lib/runtime/voiceStreamChunks.test.ts` | P | P | — |
| `src/lib/runtime/voiceViewBinding.test.ts` | P | P | — |
| `src/lib/scanner/activity.test.ts` | P | P | — |
| `src/lib/scanner/claudeNative.integration.test.ts` | P | P | — |
| `src/lib/scanner/claudeNative.test.ts` | P | P | — |
| `src/lib/scanner/codexNative.test.ts` | P | P | — |
| `src/lib/scanner/context.test.ts` | P | P | — |
| `src/lib/scanner/conversationCatalog.test.ts` | P | P | — |
| `src/lib/scanner/conversationSearchIndex.test.ts` | P | P | — |
| `src/lib/scanner/copilotNative.test.ts` | P | P | — |
| `src/lib/scanner/deleteTranscript.test.ts` | P | P | — |
| `src/lib/scanner/describe.test.ts` | P | P | — |
| `src/lib/scanner/discover.performance.test.ts` | F | P | C114 |
| `src/lib/scanner/discover.test.ts` | F | P | C10 |
| `src/lib/scanner/effort.test.ts` | P | P | — |
| `src/lib/scanner/fileScanWorker.test.ts` | P | P | — |
| `src/lib/scanner/filesResponseWorker.test.ts` | F | F | C115 |
| `src/lib/scanner/index.pin.test.ts` | P | P | — |
| `src/lib/scanner/links.performance.test.ts` | P | P | — |
| `src/lib/scanner/links.test.ts` | F | P | C73 |
| `src/lib/scanner/metadataHead.performance.test.ts` | P | P | — |
| `src/lib/scanner/model.test.ts` | P | P | — |
| `src/lib/scanner/modelRegistry.test.ts` | P | P | — |
| `src/lib/scanner/needle.performance.test.ts` | P | P | — |
| `src/lib/scanner/needle.test.ts` | P | P | — |
| `src/lib/scanner/observe.singleFlight.test.ts` | P | P | — |
| `src/lib/scanner/pinRideAlong.test.ts` | P | P | — |
| `src/lib/scanner/process.test.ts` | P | P | — |
| `src/lib/scanner/projectDirectories.test.ts` | P | P | — |
| `src/lib/scanner/projectState.test.ts` | P | P | — |
| `src/lib/scanner/questions.test.ts` | P | P | — |
| `src/lib/scanner/registryDemotion.test.ts` | P | P | — |
| `src/lib/scanner/roots.claude.test.ts` | P | P | — |
| `src/lib/scanner/roots.claudeTasks.test.ts` | P | P | — |
| `src/lib/scanner/scanCoordinator.test.ts` | P | P | — |
| `src/lib/scanner/schemeWindow.test.ts` | P | P | — |
| `src/lib/scanner/settledTurnProjection.test.ts` | P | P | — |
| `src/lib/scanner/transcriptIdentity.test.ts` | P | P | — |
| `src/lib/scanner/transcriptSearchFeed.test.ts` | P | P | — |
| `src/lib/scanner/transcripts.test.ts` | P | P | — |
| `src/lib/scanner/turnDuration.test.ts` | P | P | — |
| `src/lib/scanner/waitingInput.test.ts` | P | P | — |
| `src/lib/scanner/wakeup.test.ts` | P | P | — |
| `src/lib/search/projectScope.test.ts` | P | P | — |
| `src/lib/search/queryUnits.test.ts` | P | P | — |
| `src/lib/search/snippet.test.ts` | P | P | — |
| `src/lib/search/transcriptFeed.test.ts` | P | P | — |
| `src/lib/search/transcriptSearch.test.ts` | P | P | — |
| `src/lib/selection/resolve.test.ts` | P | P | — |
| `src/lib/selection/selectedContext.test.ts` | P | P | — |
| `src/lib/selection/taskReferences.test.ts` | P | P | — |
| `src/lib/selfUpdate/auto.test.ts` | P | P | — |
| `src/lib/selfUpdate/changelog.test.ts` | P | P | — |
| `src/lib/selfUpdate/changelogMarkup.test.ts` | P | P | — |
| `src/lib/selfUpdate/git.test.ts` | P | P | — |
| `src/lib/selfUpdate/green.test.ts` | P | P | — |
| `src/lib/selfUpdate/history.test.ts` | P | P | — |
| `src/lib/selfUpdate/managed.test.ts` | P | P | — |
| `src/lib/selfUpdate/managedAuto.test.ts` | P | P | — |
| `src/lib/selfUpdate/mode.test.ts` | P | P | — |
| `src/lib/selfUpdate/quiet.test.ts` | P | P | — |
| `src/lib/selfUpdate/routes.test.ts` | P | P | — |
| `src/lib/selfUpdate/safety.test.ts` | P | P | — |
| `src/lib/selfUpdate/steps.test.ts` | P | P | — |
| `src/lib/session/livePane.test.ts` | P | P | — |
| `src/lib/session/messagesPage.performance.test.ts` | P | P | — |
| `src/lib/session/messagesPage.test.ts` | P | P | — |
| `src/lib/session/projectAffinity.test.ts` | P | P | — |
| `src/lib/session/projectResolution.test.ts` | F | P | C116 |
| `src/lib/session/reader.performance.test.ts` | P | P | — |
| `src/lib/session/reader.test.ts` | P | P | — |
| `src/lib/session/renameEligibility.test.ts` | P | P | — |
| `src/lib/session/roleTitles.test.ts` | P | P | — |
| `src/lib/session/titleEvents.test.ts` | P | P | — |
| `src/lib/session/titleProjection.test.ts` | P | P | — |
| `src/lib/session/titleStore.interprocess.test.ts` | P | P | — |
| `src/lib/session/titleStore.test.ts` | P | P | — |
| `src/lib/spawnNotice/sweep.test.ts` | P | P | — |
| `src/lib/staging.test.ts` | P | P | — |
| `src/lib/startupDiagnostics.test.ts` | P | P | — |
| `src/lib/state/buildPhaseGuard.test.ts` | P | P | — |
| `src/lib/state/diskFull.test.ts` | P | P | — |
| `src/lib/state/durability.test.ts` | P | P | — |
| `src/lib/state/durableJson.test.ts` | P | P | — |
| `src/lib/state/hotStateStores.benchmark.test.ts` | P | P | — |
| `src/lib/state/hotStateStores.sqlite.test.ts` | F | P | C117 |
| `src/lib/state/legacyCollections.test.ts` | P | P | — |
| `src/lib/state/registryRecords.test.ts` | P | P | — |
| `src/lib/state/sqliteStateStore.bounded.test.ts` | P | P | — |
| `src/lib/state/stateLeaseRecovery.test.ts` | P | P | — |
| `src/lib/stateOwnership.entryPoints.test.ts` | P | P | — |
| `src/lib/stateOwnership.test.ts` | P | P | — |
| `src/lib/status.test.ts` | P | P | — |
| `src/lib/suggestions/store.sqlite.test.ts` | P | P | — |
| `src/lib/suggestions/store.test.ts` | P | P | — |
| `src/lib/taskAlbum/album.test.ts` | P | P | — |
| `src/lib/tasks/boardTaskLimit.test.ts` | P | P | — |
| `src/lib/tasks/boardVisibility.test.ts` | P | P | — |
| `src/lib/tasks/colorRule.test.ts` | P | P | — |
| `src/lib/tasks/curator.test.ts` | P | P | — |
| `src/lib/tasks/doneVisibility.test.ts` | P | P | — |
| `src/lib/tasks/ghostSettlement.test.ts` | P | P | — |
| `src/lib/tasks/groupHide.test.ts` | P | P | — |
| `src/lib/tasks/inboxScanner.test.ts` | P | P | — |
| `src/lib/tasks/internalConversations.test.ts` | P | P | — |
| `src/lib/tasks/lattice.test.ts` | P | P | — |
| `src/lib/tasks/launchMembership.registry.test.ts` | P | P | — |
| `src/lib/tasks/launchMembership.test.ts` | P | P | — |
| `src/lib/tasks/membership.test.ts` | P | P | — |
| `src/lib/tasks/revision.test.ts` | P | P | — |
| `src/lib/tasks/store.legacyFile.test.ts` | P | P | — |
| `src/lib/tasks/store.sqlite.test.ts` | P | P | — |
| `src/lib/tasks/supersedence.test.ts` | P | P | — |
| `src/lib/tasks/taskColorGroupHide.test.ts` | F | F | C118 |
| `src/lib/tasks/taskCreate.test.ts` | P | P | — |
| `src/lib/tasks/taskDetails.test.ts` | P | P | — |
| `src/lib/tasks/taskIcon.test.ts` | P | P | — |
| `src/lib/tasks/taskIconSuggest.test.ts` | P | P | — |
| `src/lib/tasks/taskNote.test.ts` | P | P | — |
| `src/lib/tasks/taskPriority.test.ts` | P | P | — |
| `src/lib/tasks/taskWorkLinks.test.ts` | P | P | — |
| `src/lib/tasks/tasks.test.ts` | P | P | — |
| `src/lib/team/cli.team.test.ts` | P | P | — |
| `src/lib/team/contract.test.ts` | P | P | — |
| `src/lib/team/passkeyFeedback.test.ts` | P | P | — |
| `src/lib/team/passkeys.test.ts` | P | P | — |
| `src/lib/team/streams.test.ts` | P | P | — |
| `src/lib/team/team.test.ts` | P | P | — |
| `src/lib/team/telegramSignIn.test.ts` | P | P | — |
| `src/lib/telegram/adapter.test.ts` | P | P | — |
| `src/lib/telegram/bot/service.test.ts` | P | P | — |
| `src/lib/telegram/bot/store.test.ts` | P | P | — |
| `src/lib/telegram/bot/transport.test.ts` | P | P | — |
| `src/lib/telegram/chatReference.test.ts` | P | P | — |
| `src/lib/telegram/connector.test.ts` | P | P | — |
| `src/lib/telegram/connectorBoot.test.ts` | P | P | — |
| `src/lib/telegram/hostRegistration.test.ts` | P | P | — |
| `src/lib/telegram/packaging.test.ts` | P | P | — |
| `src/lib/telegram/reportFeed.test.ts` | F | P | C119 |
| `src/lib/telegram/reportLineage.test.ts` | F | P | C73 |
| `src/lib/telegram/reportRunner.test.ts` | F | F | C120 |
| `src/lib/telegram/reportSchedule.test.ts` | P | P | — |
| `src/lib/telegram/reportSources.test.ts` | P | P | — |
| `src/lib/telegram/reportSpawn.test.ts` | F | P | C121 |
| `src/lib/telegram/reportStore.test.ts` | P | P | — |
| `src/lib/telegram/service.test.ts` | P | P | — |
| `src/lib/telegram/sessionStore.test.ts` | P | P | — |
| `src/lib/telegram/vendorPagination.test.ts` | P | P | — |
| `src/lib/telemetry/sender.test.ts` | P | P | — |
| `src/lib/tempDirs.test.ts` | P | P | — |
| `src/lib/tempSweep.test.ts` | P | P | — |
| `src/lib/timeline.test.ts` | P | P | — |
| `src/lib/title.test.ts` | P | P | — |
| `src/lib/tmux.test.ts` | P | P | — |
| `src/lib/transcribe/soniox.test.ts` | P | P | — |
| `src/lib/transcribe/sonioxLive.test.ts` | P | P | — |
| `src/lib/transcribeBackend.test.ts` | P | P | — |
| `src/lib/tts.test.ts` | P | P | — |
| `src/lib/ttsAlignment.test.ts` | P | P | — |
| `src/lib/ttsBackend.test.ts` | P | P | — |
| `src/lib/ttsChunks.test.ts` | P | P | — |
| `src/lib/view/collect.test.ts` | P | P | — |
| `src/lib/view/presenceStore.test.ts` | P | P | — |
| `src/lib/view/selectionScope.test.ts` | P | P | — |
| `src/lib/view/snapshot.openclaw.test.ts` | P | P | — |
| `src/lib/view/validation.allowlists.test.ts` | P | P | — |
| `src/lib/view/view.test.ts` | P | P | — |
| `src/lib/viewerInstrumentation.test.ts` | P | P | — |
| `src/lib/viewerWorkerLifecycle.test.ts` | P | P | — |
| `src/lib/wakeup.test.ts` | P | P | — |
| `src/lib/workflows/engine.test.ts` | P | P | — |
| `src/lib/workflows/prompts.test.ts` | P | P | — |
| `src/lib/workflows/provision.test.ts` | P | P | — |
| `src/lib/workflows/store-isolation.test.ts` | P | P | — |
| `src/lib/workflows/store.test.ts` | P | P | — |
| `src/lib/workflows/visibility.test.ts` | P | P | — |
| `src/proxy.team.test.ts` | P | P | — |
| `src/proxy.test.ts` | P | P | — |
| `src/runtime-host/bootstrapMcpHealthProbeAdmission.test.ts` | F | P | C122 |
| `src/runtime-host/candidateContainer.test.ts` | F | P | C123 |
| `src/runtime-host/candidatePort.test.ts` | P | P | — |
| `src/runtime-host/canonicalMirror.test.ts` | P | P | — |
| `src/runtime-host/deployment.test.ts` | P | P | — |
| `src/runtime-host/deploymentAdapter.test.ts` | P | P | — |
| `src/runtime-host/deploymentArtifacts.test.ts` | P | P | — |
| `src/runtime-host/deploymentBootstrap.test.ts` | P | P | — |
| `src/runtime-host/deploymentFailureReport.test.ts` | P | P | — |
| `src/runtime-host/deploymentHealth.test.ts` | P | P | — |
| `src/runtime-host/deploymentHotState.test.ts` | P | P | — |
| `src/runtime-host/deploymentList.test.ts` | P | P | — |
| `src/runtime-host/deploymentProxy.test.ts` | P | P | — |
| `src/runtime-host/dockerNames.test.ts` | P | P | — |
| `src/runtime-host/fenceWait.test.ts` | P | P | — |
| `src/runtime-host/hostBootstrap.test.ts` | P | P | — |
| `src/runtime-host/hostRehearsal.test.ts` | P | P | — |
| `src/runtime-host/hostRehearsalRun.test.ts` | P | P | — |
| `src/runtime-host/hostRelease.test.ts` | P | P | — |
| `src/runtime-host/hostRollback.test.ts` | P | P | — |
| `src/runtime-host/hostSuccessor.test.ts` | P | P | — |
| `src/runtime-host/journal.copilot.test.ts` | P | P | — |
| `src/runtime-host/journal.inject.test.ts` | P | P | — |
| `src/runtime-host/journal.sessionRead.test.ts` | P | P | — |
| `src/runtime-host/journal.test.ts` | P | P | — |
| `src/runtime-host/journalCompact.test.ts` | P | P | — |
| `src/runtime-host/journalLimits.test.ts` | P | P | — |
| `src/runtime-host/journalRetention.test.ts` | P | P | — |
| `src/runtime-host/journalSessionMetadata.test.ts` | P | P | — |
| `src/runtime-host/journalSnapshotBounds.test.ts` | P | P | — |
| `src/runtime-host/journalVacuum.test.ts` | P | P | — |
| `src/runtime-host/legacyScheduler.test.ts` | P | P | — |
| `src/runtime-host/mcpHealthProbeAdmission.test.ts` | P | P | — |
| `src/runtime-host/mcpRuntimeProbe.test.ts` | F | F | C124 |
| `src/runtime-host/mcpRuntimeRelease.test.ts` | P | P | — |
| `src/runtime-host/nativeQueueCompaction.test.ts` | P | P | — |
| `src/runtime-host/nativeQueueJournal.test.ts` | P | P | — |
| `src/runtime-host/receiptSweep.test.ts` | P | P | — |
| `src/runtime-host/runtimeHostFence.test.ts` | P | P | — |
| `src/runtime-host/runtimeHostStartup.test.ts` | P | P | — |
| `src/runtime-host/socket.test.ts` | P | P | — |
| `src/runtime-host/stagingContainer.test.ts` | P | P | — |
| `src/runtime-host/terminalProjectionRetention.test.ts` | P | P | — |
| `src/runtime-host/viewerEntries.test.ts` | P | P | — |
| `src/styles/tokens.contrast.test.ts` | P | P | — |
