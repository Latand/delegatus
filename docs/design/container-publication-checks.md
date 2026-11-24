# Container publication: where each check runs

## Requirement

Operator requirement, 2026-11-22 (Delegatus task 9f2628e4, paraphrased): a
lane's publication from inside the Viewer container must complete without a
manual push from the host. At the time every lane push from the container
failed, and every commit had been pushed by hand for two days. No publication
check may be skipped or weakened.

Design question for this document (pinned on the follow-up lane, 2026-11-24):
which mechanism lets container publication finish within the remote's idle
limit, with no privacy check weakened, and with the smallest surface that
cannot leak inputs? Compare (A) a sandboxed scanner behind the privacy
receipt, (B) a receipt for the heavy checks only with privacy kept in the
pre-push hook, and (C) anything simpler found in the code. Recommend one, with
evidence, and give a step-by-step implementation plan against PR #4376 at
4f3c4fff.

## Answer

Choose **B**. Main already has it: since #3549 (2026-11-02) the controller
runs the heavy checks before `git push` under a single-use receipt bound to the
commit and the check runner's inputs ("publication capability 1"). The native
pre-push hook then runs only the privacy scan, fresh, while Git holds the
transport.

The SIGPIPE failures that started the sealed privacy receipt came from the
lane itself. Its first commit (334f39b6) raised
`scripts/local-gate-capabilities.json` to `publicationPrepare: 2`. The deployed
controller accepts only capability 1, so it published every head of lanes
3730c10f and 9b4c476a through the ordinary in-hook path. That path runs types,
lint and touched tests while the SSH transport sits idle, and the remote closes
an idle connection after about six minutes (measured below).

The fix is to keep B and give the in-hook privacy phase a fixed allowance well
under that limit. Port the container fixes the lanes found, then delete the
sealed privacy receipt and everything that exists only to support it. Privacy
then is never certified ahead of transport, so no scanner input can escape a
seal. The scanner reads its live inputs at transport time, through the same
step definition as every ordinary push.

## Evidence

All observations were read on 2026-11-24 from the delivery journal in the
Viewer's state database (read-only), the Git history, and scratch measurements
described in "Measurement record" below.

### Why every container publication failed

The delivery journals record 39 container publications that ran repository
checks and failed between 2026-11-22 and 2026-11-24. The first column is the
declared capability of the lane's heads (read with
`git cat-file -p <sha>:scripts/local-gate-capabilities.json`).

| Heads | Attempts | Path the deployed controller took | Outcomes |
|---|---|---|---|
| Capability 2 (lanes 3730c10f, 9b4c476a) | 16 | Ordinary hook: `git push` first, then privacy, types, ESLint and touched tests inside the hook | 10 SIGPIPE after 457–907 s, each preceded by "Connection to the forge closed by remote host"; 4 type failures; 1 privacy refusal; 1 CPU admission deadline |
| Capability 1 (ten other lanes) | 23 | Preparation before transport (main's capability-1 flow) | 18 privacy scanner "input unreadable" (several also hit the read-only lock below); 2 `gate-slot.sh` read-only `/var/tmp` lock files only; 3 CPU queue waits ended by the 15-minute budget. None reached the transport (see below) |

Code that decides the path:

- The deployed release fe4d6835 prepares a checkout only when
  `supportsPublicationPreparation` holds (`src/lib/pipelines/git.ts:2490`).
  That helper accepts exactly `publicationPrepare === 1`
  (origin/main `src/lib/git/publicationCheckReceipt.ts:15`). A capability-2
  checkout therefore gets no receipt, and its hook runs every check in
  ordinary mode. The capability-2 outputs show exactly that: "pre-push: CPU
  admission for publication checks", "pre-push: push checks", then type and
  lint results inside `git push`.
- The executor labels a failed preparation with the push's step name,
  "publishing the pipeline branch" (fe4d6835 `src/lib/pipelines/git.ts:2205`).
  The capability-1 refusals therefore read like push failures. They ran in
  preparation: they end after 12–47 s, or at the 15-minute budget, and none
  contains the hook's "transport admitted" line or a closed connection.

The capability-1 causes are being fixed elsewhere. The privacy reader was
fixed for the image's Git 2.39 by #4396 (f36434ce, on main and merged into this
branch). The read-only lock files are fixed on this branch in
`scripts/gate-slot.sh` and `scripts/cpu-admission.ts`. Queue self-fencing was
fixed by #4366 on main, which this branch also contains.

**Observation:** no SIGPIPE was ever recorded on a capability-1 head.
**Inference:** the prepared flow on main already keeps the heavy checks off the
transport; it failed in the container for the reasons above, before transport.

### The remote's idle limit

| Source | Result |
|---|---|
| Journal, capability-2 attempts | The hook ran 344.8 s and 282.7 s with no closed-connection line; the transport survived. One attempt (2026-11-24 01:51) printed the closed-connection line and died by SIGPIPE at 457.6 s |
| Direct probe 1 (2026-11-24) | SSH `git-receive-pack` session to the lane's remote, reading the ref advertisement (48 KB) and then sending nothing: the remote closed it after **362.3 s** with the same "closed by remote host" message |
| Direct probe 2 (2026-11-24) | The same session, repeated: closed after **362.1 s** with the same message |
| Network path | The container uses host networking (`docker-compose.yml:10`, `network_mode: host`), so no NAT timer is involved. The SSH client configuration sets no `ServerAliveInterval` |

**Conclusion:** the remote drops an SSH push that sends nothing for about
360 s. Everything that runs between the ref advertisement and the pack
(the whole pre-push hook) must end well before that.

### Hook phase durations

Recorded in the journal outputs of container hooks (`pre-push: <step>: passed
in N s`):

| Phase | Samples | Duration |
|---|---|---|
| types | 5 | 28–300 s (median 42 s); a lane head took 323 s on the host (task record, 2026-11-03) |
| ESLint | 5 | 10–15 s |
| touched tests | 0 complete | still running when the connection closed in every capability-2 SIGPIPE |
| ordinary hook budget | | 15 min, or 25 min for pipeline-engine changes (`src/lib/pipelines/gateBudget.ts:1–4`) |

The ordinary in-hook path therefore cannot fit inside 360 s whenever a check
misses the pass cache. This holds for any SSH push of cold checks, including
one from the host.

### Privacy scan duration

The command is the hook's privacy step (`scripts/local-gate.ts:72–73`):
`bun scripts/privacy-publication-gate.ts --base <base> --require-known-values
--check-commits --added-lines`. It ran under pinned Bun 1.4.0 in a scratch
shared clone, with isolated HOME, XDG and TMPDIR directories and a fresh
fingerprint cache per case. The committed fingerprint catalog and the role
memory known-values file were the inputs. There were three runs per case, on a
16-core machine at load average 6–9.

| Case | Commits | Files | Runs (s) | Gate |
|---|---|---|---|---|
| Typical push (latest merged PR) | 1 | 4 | 1.4, 0.7, 0.8 | PASS |
| This lane (f36434ce..4f3c4fff) | 18 | 27 | 9.3, 8.6, 9.3 | PASS |
| Large (10 merged PRs) | 10 | 205 | 17.9, 17.1, 18.7 | FAIL* |
| Stress (40 merged PRs) | 40 | 516 | 56.4, 56.0, 58.4 | FAIL* |

\* Main's squash commits carry forge-composed co-author identities. The
publication gate refuses those for a lane push (`merge_boundary`), which is
expected. The scanner completed and listed every finding, so the duration
covers the whole range.

For scale, among the last 198 merged PRs the median changed 7 files, the 90th
percentile 22, the 95th 29 and the largest 116. The large case is therefore
above every PR in that window, and the stress case is 4.4 times the largest.

The transport hook also fingerprints the checkout twice (receipt check and
post-scan recheck). On this checkout `installedFingerprint` took 7.4 s cold and
about 1.0 s warm, and `workingInputsFingerprint` took 1.4 s cold and about
0.3 s warm (three iterations each).

### What the sealed privacy receipt costs (4f3c4fff)

- Five consecutive review rounds (3730c10f attempts 4–5, 9b4c476a attempts
  1–3) found scanner inputs outside the sealed set: a writable catalog copy,
  an overwritten catalog variable, `.git/info/attributes`, an absent configured
  source, an explicit missing `core.attributesFile` and the raster provenance
  interpreter, plus the retry and budget edge cases around them. The inventory has no
  natural end: anything the scanner, Git or Bun reads or executes is an input.
- `scripts/publication-scan-inputs.ts` (221 lines) copies every object in the
  repository (1.2 GB in this clone) into the gate sandbox for each preparation.
  `COPYFILE_FICLONE` falls back to a full copy here because the host's
  `/var/tmp` and home are ext4 and `/tmp` is tmpfs.
- It needs a dedicated retry class (`retryablePrivacyDrift`) and a 21-line
  classifier with an allowlist of routine diagnostic lines
  (`src/lib/pipelines/publicationHistory.ts:22–42`).
  The last review round still found routine lines missing from that list.

## Options compared

| | A: sandboxed scanner behind the receipt | **B: heavy-check receipt, privacy in the hook** | C1: push to a temporary ref, verify server-side | C2: run the full gate outside Git, then `git push --no-verify` |
|---|---|---|---|---|
| Mechanism removed or added | Keeps all of 4f3c4fff's sealing (snapshot, object copy, drift retry, capability-split budget) and adds a `bwrap` invocation, a bind inventory and an image dependency (the image installs no bubblewrap) | Removes the sealed privacy receipt and its retry class, the 60 s admission timer and the capability-split budget. Adds one constant (transport hook allowance). Keeps main's #3549 receipt for heavy checks | Removes the hook from publication. Adds a server-side verification job and temporary-ref cleanup | Removes the receipt and the transport hook. Adds controller-side copies of the hook's ref checks |
| Inputs that could still leak | Files outside the binds fail closed, but every bind is an input: Bun, Git and its helpers and libraries, the raster interpreter, LLV_PRIVACY_* and Git environment. Each still needs a hash in the receipt, so the inventory chase continues for executables and environment | Privacy: none beyond an ordinary push. The scan reads live inputs at transport, and the hook binds the pack to the one scanned ref. Heavy checks: the same exposure as today's pass reuse, which uses the same `gateInputSnapshot` key | All of it. The repository is public, and unscanned commits are fetchable the moment the temporary ref exists | Refs or tags added by Git configuration (`push.followTags`, `remote.*.push`, mirror) reach the remote unseen. Annotated tag messages are content no check read |
| Transport budget, capability 1 / 2 | As 4f3c4fff: 2×preparation capped by the push budget / 60 s + 60 s pack | 180 s hook + 60 s pack, for both | No hook | No hook |
| Failure modes | `bwrap` absent or denied fails every publication closed. Object copy of 1.2 GB per preparation. Bind list drifts with image upgrades. No macOS equivalent for the portable hook | Scan slower than 180 s at transport gets a named deadline, retried after 1, 5 and 15 min, then parked. Capability-2 heads under an old controller take the in-hook path until the deploy | Irreversible publication of unscanned content | Unchecked extra refs. Breaks the project rule that local hooks mirror the publication gate |
| Test plan | A negative control per bind; `bwrap` absent and denied; macOS fallback; object-copy cleanup | T1–T6 below | n/a | n/a |

Also considered and set aside:

- **SSH keepalive** (`ServerAliveInterval`). It is unverified whether the
  remote counts SSH-level keepalives as activity, and the transport would
  still stay open for 15–25 minutes per push.
- **HTTPS transport.** Discovery and pack upload are separate requests, so no
  connection idles. It needs an HTTPS credential for repositories that are not
  declared App repositories, and it removes no mechanism. Both are listed
  under Deferred.

A and both C options fail at least one invariant: A keeps an open-ended input
inventory, and C1 and C2 publish content or refs that no check saw.

## Recommendation: B, with a fixed transport allowance

1. **Preparation** (`local-gate.ts pre-push --publication-prepare`, run by the
   controller before `git push`) is unchanged from main. It runs the full plan,
   privacy included, under the CPU queue and the publication budget (15, 25 or
   30 minutes from `gateBudget.ts`). It then writes the single-use receipt bound
   to `gateInputSnapshot` (head, tree, base, branch, runtime, toolchain,
   installed dependencies, working inputs, environment, Git configuration), the
   plan and the operation binding (id, epoch, fence, head, ref, remote head).
   The receipt must be consumed within 60 s (`PUBLICATION_TRANSPORT_MS`).
2. **Transport** (the native hook during `git push`) is also main's: consume the
   receipt, re-take the snapshot, and run the plan's privacy step once against
   private copies of the current known-values files. Then re-check the snapshot
   and admit transport. The privacy step is not `capped`, so the transport never
   waits in the CPU queue.
3. **New:** the controller gives every prepared transport the same hook
   allowance, `PUBLICATION_TRANSPORT_HOOK_MS = 180_000`, plus the existing 60 s
   pack margin. That makes `LLV_GATE_PUSH_DEADLINE` now + 180 s and the
   `git push` timeout 240 s (never above the publication budget). This replaces
   both main's `max(60 s, 2 × preparation)` formula (up to 24 minutes for a
   25-minute budget) and 4f3c4fff's capability split.
4. **Capability 2 keeps one meaning:** "the native hook runs under the image's
   Bun inside the container, so prepare under the same interpreter". This is
   what 334f39b6 declared it for. The controller already picks
   `process.execPath` for capability 2 when it runs as `bun-container`; both
   ends then fingerprint the same runtime and toolchain. Capability 2 never
   reached main, so redefining it breaks no released checkout.

### Invariant check with numbers

The transport is idle from the ref advertisement to the end of the hook: about
1–2 s of connection set-up plus the hook. The bound is 182 s, about half of the
measured 362 s limit.

| Push | Expected hook work at transport | Allowance used | Outcome |
|---|---|---|---|
| Typical (1 commit, 4 files) | 0.7–1.4 s scan + 2 snapshots (1.3–8.8 s) ≈ 2–10 s | ≤ 6 % | publishes |
| This lane (18 commits, 27 files; about the 95th-percentile PR) | ≈ 9 s + 1.3–8.8 s ≈ 11–18 s | ≤ 10 % | publishes |
| Large (205 files) | ≈ 18 s + 1.3–8.8 s ≈ 19–27 s | ≤ 15 % | publishes |
| Stress (516 files) at 2× CPU contention | ≈ 117 s + 17.6 s ≈ 135 s | 75 % | publishes |
| Scan beyond 180 s (pushes about 10× the largest recent PR, or a hung scanner) | hook ends with "no verdict within the push budget" naming privacy | 100 % | `retryableDeadline`, retried after 1, 5 and 15 min, then parked with the cause; no pack sent, the remote ref unchanged |
| A hook that overruns its own deadline | controller stops `git push` at 240 s, before the remote's 362 s | n/a | uncertain outcome; reconciliation reads the remote ref and finds it unchanged, since no pack was sent, as for any interrupted push |
| Receipt older than 60 s at the hook | refused as stale, as on main | n/a | a later attempt prepares again, and heavy checks reuse their passes |

No measurement is required at run time; the allowance is a constant. The
heavy checks never run while the transport is open.

## Budgets by capability

| | Preparation (no transport open) | Transport hook | `git push` timeout | Receipt freshness |
|---|---|---|---|---|
| main today, capability 1 | publication budget | `min(budget, max(60 s, 2 × preparation) + 60 s) − 60 s` (up to 24 min) | `min(budget, max(60 s, 2 × preparation) + 60 s)` | 60 s |
| 4f3c4fff, capability 1 | publication budget | same as main | same as main | 60 s |
| 4f3c4fff, capability 2 | publication budget, inside one CPU admission bounded at 60 s | 60 s, no privacy scan | 120 s | 60 s |
| **B, capability 1** | publication budget (prepared with `bun`) | **180 s** (privacy scan) | **240 s** | 60 s |
| **B, capability 2** | publication budget (prepared with `bun-container` in the image) | **180 s** (privacy scan) | **240 s** | 60 s |
| No or unknown capability | n/a | ordinary hook, full publication budget | budget | n/a |

The 4f3c4fff regression's own example still holds under B. A capability-1
checkout with 70 s of preparation had a 140 s hook allowance on main and gets
180 s.

## Disposition of the review findings

The four findings still open at 4f3c4fff (lane 9b4c476a, review attempt 3):

| Finding | Disposition under B |
|---|---|
| P1: an explicit missing `core.attributesFile` authorises transport | **Moot.** No receipt certifies privacy. The transport's own scan reads Git's effective attributes at that moment, as every ordinary push does, and only its PASS admits the pack |
| P1: the raster provenance interpreter (`LLV_PRIVACY_GENERATOR_BUN`) runs outside the receipt | **Moot.** The interpreter runs inside the authoritative scan at transport. Nothing earlier vouches for it |
| P2: routine diagnostics suppress the drift retry | **Moot.** `retryablePrivacyDrift` and `publicationPrivacyDrift` are deleted; with nothing certified, privacy inputs cannot drift between preparation and transport. Drift in heavy-check inputs keeps main's refusal, which names the changed component |
| P2: the committed v1 budget test skips the real hook | **Resolved.** The in-process case (`src/lib/pipelines/git.test.ts:2281–2320`) is deleted. Main's cross-process cases in `scripts/local-gate.transport.test.ts` ("measured publication transport handles …", "an overrun after … ends with its deadline verdict") drive the real native hook with a logical clock. They are updated to the fixed allowance (T1) |

Earlier findings from lanes 3730c10f and 9b4c476a:

| Finding (round) | Disposition |
|---|---|
| A full privacy scan holds the open transport; the hook may get 24 min (3730c10f r2, P1) | Resolved by the 180 s allowance; the scan itself takes 1–58 s |
| Cold tool preparation waits beyond the 60 s admission bound (3730c10f r2, P1) | Moot: the 60 s admission timer is removed. Preparation holds no transport and waits under the publication budget, as on main |
| Admission timeout classification for tool preparation (3730c10f r3, P1) | Moot: same removal |
| Receipt certifies bytes the scanner never read; configured catalog overwritten; Git attribute overlays outside the receipt; missing configured source at snapshot (3730c10f r3–r4, 9b4c476a r1–r2, P1) | Moot: no privacy receipt |
| Catalog drift loses the accepted-head retry (several rounds, P2) | Moot: no privacy receipt |
| v1 loses its elapsed-time bound (3730c10f r4, 9b4c476a r1–r2) | Superseded by the fixed bound below the idle limit |
| `LLV_DOCKER_NSENTER_SHIMS` stripped from the hook (3730c10f r1, P2) | Kept fix |
| Read-only lock exclusion test can pass before the entrant locks (3730c10f r1, P2) | Kept fix |
| Interrupted transport loses phase timings (3730c10f r2, P2); exact success assertion breaks on `phaseTimings` (9b4c476a r1–r2, P2) | Kept fixes |
| The lane's controller never published from the container (3730c10f r1, P1, WRONG-PREMISE) | Explained above: capability 2 under the capability-1 controller. The live proof follows the deploy |

## Implementation plan

Work on this branch (PR #4376). Merge `origin/main` first so the base includes
#4396 and #4366. Each kept hunk needs either a journal cause listed here or a
test that fails without it. Restore everything else to `origin/main`.

### Step 1: delete the sealed privacy receipt

| File at 4f3c4fff | Action |
|---|---|
| `scripts/publication-scan-inputs.ts` | Delete the file |
| `scripts/gateSandboxRecords.ts` | Restore main (drop `removePublicationScan`) |
| `scripts/local-gate.ts:20` | Drop the import |
| `scripts/local-gate.ts:628`, `runPrepared` `passed` tracking, `cleanup?.(passed)` | Restore main's `cleanup?: () => void` |
| `scripts/local-gate.ts:1134–1138` | Restore main's `privacyEnv` (always the committed fingerprint catalog) |
| `scripts/local-gate.ts:1139–1145, 1192–1199` (`privacySnapshot`, `snapshotDrift`, sealed root and env for the privacy step) | Delete; restore main's `if (step.name === "privacy") Object.assign(env, privacyEnv)` |
| `scripts/local-gate.ts:1248–1303` (`checkDigest`, `changedPrivacyInputs`, the "privacy scan" component, transport without a scan) | Restore main's lines 1200–1253: receipt key without privacy, and a transport that copies the known-values files and runs the privacy step |
| `scripts/local-gate.ts:1346–1356` (`snapshotDrift` check, `checkDigest` in the receipt) | Restore main's receipt write (main :1299–1302), keeping `checksMs` (step 3) |
| `src/lib/pipelines/publicationHistory.ts:22–42` and the `retryablePrivacyDrift` term at :94 | Delete |
| `src/lib/pipelines/types.ts:1097–1098` (`retryablePrivacyDrift`) | Delete |
| `src/lib/pipelines/git.ts:8` (import), `:2184–2185`, `:2219` | Delete the drift classification |

### Step 2: delete the 60 s admission timer and admitted preparation

| File at 4f3c4fff | Action |
|---|---|
| `scripts/local-gate.ts:943–975` (`runAdmittedChecks` `admissionMs`, label, timer, `LLV_GATE_WAIT_STARTED`) | Restore main |
| `scripts/local-gate.ts:1220–1230` (preparation re-entered under one admission with `--admitted`) and `:1348` (`admitted && !publicationPrepare`) | Restore main's preparation (`publicationPrepare && !config` installs pinned tools, then runs the ordinary privacy-and-checks pair) |
| `scripts/local-gate.ts:1029–1034` (preparation and transport env defaults), `:1044` (`LLV_GATE_ADMISSION_WAIT_ROOTS`), `:1045–1050` (PATH prefix), `:1377` (argv parsing) | Restore main, unless a native test fails without one of them. Keep only that hunk and name the test in the commit |
| `scripts/gate-cache.ts` and `scripts/gate-cache.test.ts` (`runTransport`) | Restore main, under the same condition |
| `src/lib/pipelines/publication.ts:62`, `src/lib/pipelines/git.ts:1667–1670` | Restore main |
| `CONTRIBUTING.md` | Drop the sentence about the 60 s admission allowance; keep the read-only lock provisioning paragraph |

### Step 3: keep the container fixes and the timings

| File | Keep | Why |
|---|---|---|
| `scripts/gate-slot.sh`, `scripts/gate-slot.test.ts`, `scripts/gate-slot.queue.test.ts` | read-only slot and claim locks on existing inodes | journal: `Read-only file system` on the lock files (2026-11-03, 2026-11-22, 2026-11-23) |
| `scripts/cpu-admission.ts` | open lock files read-only; recognise `bun-container` as a hook interpreter | same lock files; hooks under the image's Bun |
| `.githooks/pre-push` | run under `/usr/local/bin/bun-container` inside the image | the hook stays in the mount namespace Git publishes from; the `bun` shim enters the host's (`Dockerfile:137`) |
| `scripts/local-gate.ts:238` | `LLV_DOCKER_NSENTER_SHIMS` in isolated checks | 3730c10f r1 P2 |
| `scripts/local-gate.ts:1148–1154` | under `bun-container`, run `bun` steps with `process.execPath` and types with `node node_modules/typescript/bin/tsc` | the `bun`/`bunx` shim runs `/bin/sh -c 'cd …'` in the host's mount namespace, where a container-only check directory does not exist. The host's `/bin/sh` is bash, which explains the unexplained "sh: line 1: cd: …: No such file or directory" type failure of 2026-11-03 |
| `scripts/local-gate-capabilities.json` | `publicationPrepare: 2`, with the meaning in Recommendation item 4 | the controller must know which interpreter the hook uses |
| `src/lib/git/publicationCheckReceipt.ts` | `publicationPreparationVersion` (1 or 2), `checksMs` | capability detection; phase timings |
| `src/lib/pipelines/git.ts` | `LLV_DOCKER_NSENTER_SHIMS` pass-through (:1731–1733); `preparingChecks` for `process.execPath` (:2116–2117); preparation runtime choice (:2526); `phaseTimings` in results, journal and reconciliation | container fixes; timings for the live proof |
| `src/lib/pipelines/types.ts` | `phaseTimings` | same |
| `scripts/local-gate.fixture.ts`, `scripts/publicationHook.fixture.ts` | keep only the parts a remaining test uses | |

### Step 4: one transport allowance

- `src/lib/pipelines/gateBudget.ts`: add `PUBLICATION_TRANSPORT_HOOK_MS = 180_000`.
  Comment it with the measured remote idle limit (about 360 s, this
  document).
- `src/lib/pipelines/git.ts:2534–2539`: replace the capability-dependent
  formula with `transportBudgetMs = Math.min(budget.ms, PUBLICATION_TRANSPORT_HOOK_MS + PUBLICATION_PACK_MARGIN_MS)`.
  Keep `pushEnv.LLV_GATE_PUSH_DEADLINE = publicationHookDeadline(transportBudgetMs, Date.now())`
  as it is. Delete the comment about capability 1 scanning in its hook; both
  capabilities do.
- `CONTRIBUTING.md`: one sentence beside the publication budget text: a
  prepared push gives its pre-push hook 180 s, because the remote closes an
  idle SSH push after about 360 s.

### Step 5: tests (by path, one file at a time, pinned Bun 1.4.0, isolated HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR)

- **T1** `scripts/local-gate.transport.test.ts` (starts an HTTP server; runs
  in CI). In "measured publication transport handles …" and "an overrun after
  … ends with its deadline verdict", expect `timeoutMs` 240 s and a hook
  deadline 180 s after the push starts, for 70 s and 600 s preparations alike.
  The privacy scanner runs twice (preparation and transport), and one RPC
  lands. "Over cap": a transport scan that passes 180 s ends with
  `retryableDeadline: true`, `hookStoppedCheck: "privacy"`, no RPC and an
  unchanged ref. In "a gate with … preparation capability keeps one ordinary
  gated push" (main line 104), change the unsupported marker from 2 to 3.
- **T2** `scripts/local-gate.publication.test.ts`: restore main's cases
  "prepared checks are consumed once by a fresh native hook, with fresh privacy
  and no second admission", "a privacy-only refresh retains all reused heavy
  checks" and "a known-values change inside the fresh privacy scan refuses with
  its component". Delete "the real scanner starts from the sealed checkout …",
  "privacy drift refuses its receipt …" and the sealed-input cases. Add one
  case: a known value appears in the known-values file after preparation and
  before transport, and the hook refuses with `PRIVACY GATE: FAIL` and sends no
  pack. This proves privacy reads transport-time inputs.
- **T3** `scripts/local-gate.native.test.ts`: restore main's expectation that
  the transport hook calls `scripts/privacy-publication-gate.ts` once. Delete
  "cold Codex preparation has bounded shared admission …". Keep its
  `LLV_DOCKER_NSENTER_SHIMS` and isolated-HOME assertions inside an existing
  cold-install case.
- **T4** `src/lib/pipelines/git.test.ts`: replace the `capability $capability
  with $elapsed ms` table (:2281–2320) with one case per capability. Each
  asserts the preparation interpreter (`process.execPath` for capability 2
  under `bun-container`, `bun` otherwise), a 240 s push timeout and one landed
  push. Keep the `phaseTimings` cases.
- **T5** `src/lib/pipelines/publication.test.ts`,
  `src/lib/pipelines/parkedPublication.test.ts`: delete the drift and
  tool-preparation admission cases; keep the rest.
- **T6** `scripts/local-gate.test.ts`, `scripts/local-gate.binding.test.ts`,
  `scripts/gate-slot.test.ts`, `scripts/gate-slot.queue.test.ts`: run as they
  are.

Then run `bun scripts/privacy-publication-gate.ts --require-known-values
--check-commits --base origin/main`. Confirm that the three-dot diff touches no
`scripts/privacy-*` or `scripts/generate-privacy-*` file and that the required
CI checks are green. The full type check runs at publication, as the project
instructions assign.

### Step 6: rollout and live proof (seat)

Until the deploy, every head that carries capability 2 (this PR, and every lane
that merges main after it) goes through the deployed controller's ordinary
in-hook path and will hit the idle limit. Keep publishing those from the host,
as now, and deploy promptly after the merge. After the deploy, the proof is
one container self-publication whose journal line reads `publication verified:
published; phases preparation=… checks=… transport=…`, with `transport` far
below 180 s (expected under 30 s for a typical lane).

## Check against the requirement

- **Publication from the container without a host push.** After the deploy,
  the transport stays idle for at most 182 s against a measured 362 s limit.
  The heavy checks run before the transport opens. The container defects seen
  in the journal (read-only locks, the shim's namespace switch, Git 2.39
  attributes, queue self-fencing) are fixed on main or by the kept hunks.
- **No check skipped or weakened.** Preparation runs main's full plan,
  privacy included. The hook runs the same privacy step again at transport
  with live inputs, which 4f3c4fff had replaced by a certificate. The scanner,
  its arguments and its catalogs are those of main.
- **Smallest surface that cannot leak inputs.** Nothing about privacy is
  certified ahead of time, so there is no inventory of sealed inputs to keep
  complete.

## Deferred — not currently justified

- **Option A's sandbox.** Nothing needs it once privacy is not certified.
- **Honouring a configured `LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE` in the
  hook.** Main always uses the committed catalog; changing that is a separate
  behaviour change.
- **A CPU admission timer for ordinary host pushes.** A manual SSH push of
  cold checks hits the same 360 s limit, but that is outside this requirement.
- **Prepare-then-push for manual host pushes.** This would give host pushes
  the same protection; it is a separate change.
- **SSH keepalive or HTTPS transport.** Unverified benefit or new credentials.
- **The executor's failure label.** A failed preparation is recorded as
  "publishing the pipeline branch" (`src/lib/pipelines/git.ts:2214`), which
  misled this investigation. Rename it only after checking every consumer of
  `failure.step`.
- **`GIT_NO_REPLACE_OBJECTS` and `GIT_GRAFT_FILE` hardening for the privacy
  reader.** Unrelated to the transport limit.

## Measurement record

- Journal: the `delivery.journal` of every pipeline record (active and
  archived), read-only from the Viewer's SQLite state on 2026-11-24, for
  entries since 2026-11-22. Capabilities were read from each lane's published
  or last passed commit, and from every commit on this branch since 334f39b6.
- Idle probes, 2026-11-24, from the host (the container shares its network):
  `ssh -o BatchMode=yes -o ServerAliveInterval=0 -T <remote> "git-receive-pack '<repository>'"`,
  with standard input held open by a sleeping writer that sends nothing, and
  the exit time recorded. No ref was updated.
- Privacy timings, 2026-11-24: the scratch driver checked out each head in a
  `git clone --shared --no-checkout` clone and ran the command above under
  `timeout 600` through the stage's gate wrapper. Three serial iterations ran
  per case.
- Snapshot cost: `installedFingerprint` and `workingInputsFingerprint` from
  `scripts/gate-cache.ts`, three iterations on this checkout.
- PR sizes: `git diff --shortstat` of the last 198 first-parent commits on main.
