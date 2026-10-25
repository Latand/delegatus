# Codex Cloud test fixes

Origin: Codex Cloud, GPT-6.1 Sol, collected on 2026-10-23. The cloud reports
explicitly said their gated tests had not run. Local application and admitted
verification began from main at `adce5764927f7e838f20070cd2968128912e861c`.
During verification, main advanced to
`3dffc54e145fcba779e3ec82fdcff53030728da3`; the delivery branch fast-forwarded
to include its catalog-startup change. None of this task's test or production
files changed in that upstream range. Final checks use the refreshed tree.

All three proof records were checked before application: base, byte count,
SHA-256 and the separately recorded local SHA-256 agreed.

| Result | Bytes | SHA-256 |
| --- | ---: | --- |
| 13 | 8427 | e6c6f0ad2d23a020bbaa8e548f42c61309f4d0eaf82927a0c41b1efd04f76756 |
| 16 | 6456 | efa882398a914182eff8d0dc432796cb6ee5fe273a8bca948ac2853458a0b37e |
| 17 | 11519 | 2f0e10c73728d88f344556d2dfb3c43c4a42a8a088818521e634b7fcc3ab1ad4 |

## 13: seat-tick controller — kept with fixture completions

Main: 43 pass, 63 fail, exit 1. The report had named 64 failures.
Branch: 106 pass, zero failures, exit 0.

The cloud fix releases admission ownership after a fixture child materializes,
and aligns unreadable-child expectations with terminal launch accounting.
Additional failures required a private alias-test state directory, bridge-channel
initialization before report writes, and a synthetic repository whose canonical
identity agrees with the rotation fixture's cwd. The real project gate remains
in use. A successful-rotation assertion was added.
The authentication restart subprocess uses a fixed diagnostic monotonic clock.
A final loaded-runner replay exposed a normal 52 ms transaction warning in its
strict stderr assertion (105 pass / 1 fail, exit 1); the fixed child clock keeps
that assertion exact without storage-scheduling noise.

The alias test restores its prior state root and leaves its migrated database
for the fixture's normal teardown. Bridge setup follows
`src/lib/state/legacyCollections.ts`, which imports channels at activation.
Controller, rotation and state-store production code are unchanged.

## 16: compacted relay retries — dropped

Three complete main runs each returned 92 pass, one failure, exit 1.
All 48 compacted-retry cases passed in every run: 144 executions.
The repeated failure belongs to the missing-recipient authority fixture:
it receives an unknown-project refusal before its expected operator-only
refusal. The compacted-retry flake was not reproduced.

The applied cloud candidate returned the same 92 pass / one failure, exit 1.
All 48 compacted-retry cases passed there too. The final relay test file equals
main. The candidate was dropped because the named flake was not reproduced.

## 17: privacy and route fixtures — kept with verified completions

With OCR installed, main's privacy file returned 632 pass, ten failures,
exit 1. Six failures concern the generator pinned to Bun 1.3.3; four concern
the existing CPU-growth assertions under native Bun 1.4.0. The first run,
before OCR provisioning, returned 621 pass and 21 failures.

The generator helper verifies an independently selected Bun 1.3.3 executable.
Both fixture generation and trusted reproduction use it. Source hashes,
manifest checks, the generator version and detector policy remain intact.
Wrong-version and missing-runtime tests retain refusal coverage. The selected
executable is normalized to an absolute path so reproduction from another cwd
uses the verified binary; a relative-path fixture covers that resolution.

Profiling isolated the scaling failures to the combined literal-matching
regular expressions. Source and raw-comment passes now share a forward
token reader with the same contextual predicates, quote/comment expressions,
regex escape rules and line boundaries. Overlapping failed openers retry
at the next character. The existing three CPU pairs, 8x input growth, 32x
growth limit, all 15 shapes and all nine sources remain unchanged.
Optional timing diagnostics print before the assertion so red samples are visible.

Route fixture completions initialize bridge channels before report transactions,
seed reports independently per case, clear caller attribution, isolate tick-state
databases and provide the MCP fixture's authorized-seat evidence. HTTP/MCP
parity and refusal assertions remain intact.

## Commands and outcomes

Test shorthand below expands exactly to:

```sh
gate-remote -- bun test FILE --timeout=60000
```

Every remote invocation uses fresh HOME, XDG configuration/cache, temporary and
Delegatus state roots. The repository's preload starts its owned test runner.
The control URL points at a closed loopback endpoint. Calls run sequentially.
Baseline commands use an untouched detached export of the stated main revision.

| Number | FILE | Main exit / result | Branch exit / result |
| --- | --- | --- | --- |
| 13 | src/lib/monitor/seatTickController.test.ts | 1; 43 pass / 63 fail | 0; 106 pass |
| 16 | src/lib/orchestrator/relay.test.ts | 1, 1, 1; each 92 pass / 1 unrelated failure | 1; 92 pass / same unrelated failure; dropped |
| 17 | scripts/privacy-publication-gate.test.ts | 1; 632 pass / 10 fail with tools | 0; 643 pass under native Bun; 643 pass under pinned Bun |
| 17 | src/app/api/bridge/route.test.ts | 1; 3 pass / 12 fail | 0; 15 pass |
| 17 | src/app/api/orchestrator/reports/route.test.ts | 1; suite setup fails before cases | 0; 2 pass |
| 17 | src/app/api/monitor/seat-tick/settings/route.test.ts | 1; 28 pass / 3 fail | 0; 31 pass |

Privacy full-file commands wrap the same test command with the provisioning
script below. Two incomplete OCR dependency preparations exited 127 before
tests started; supplying the missing libraries completed setup. The first
cloud-only privacy candidate returned 639 pass / 4 fail, exit 1. After the
scanner correction it returned 643 pass / 0 fail, exit 0. The overlapping-opener correction also passed the full file. A later relative-
path equality probe exposed an unnormalized path, exit 1 (642 pass / 1 fail).
Normalizing the selected executable fixed that probe, exit 0. The pinned
Bun 1.3.3 compatibility run passed all 643 tests, exit 0.

`git apply --check` and `git apply` for 13, 16 and 17 each exited 0.
The artifact proof verifier, `git fetch origin main`, and
`bun install --frozen-lockfile` exited 0.
Local ESLint on all retained TypeScript files exited 0.
The main refresh, `git merge --ff-only origin/main`, and the relay equality
check each exited 0. The scoped upstream file comparison also exited 0.

### Intermediate checks

These failures guided the fixture and scanner corrections; final results above
come from the completed implementation.

| Command suffix after gate-remote -- | Exits in execution order |
| --- | --- |
| bun test src/lib/monitor/seatTickController.test.ts --timeout=60000 -t 'touching unchanged credentials before first detection' | 1 |
| bun test src/lib/monitor/seatTickController.test.ts --timeout=60000 | 1, 0, 1 (diagnostic clock), 0 |
| bun test src/lib/monitor/seatTickController.test.ts --timeout=60000 -t 'touching unchanged credentials before first detection\|first failure rotates once' | 1 |
| bun test src/lib/monitor/seatTickController.test.ts --timeout=60000 -t 'first failure rotates once\|touching unchanged credentials before first detection' | 1 |
| bun test src/lib/monitor/seatTickController.test.ts --timeout=60000 -t 'first failure rotates once' | 1, 1 (probe import error), 0 |
| bun test scripts/privacy-publication-gate.test.ts --timeout=60000 -t 'all sources stay bounded' | 1, 1, 1, 1, 1, 0 |
| env LLV_PRIVACY_TEST_TIMINGS=1 bun test scripts/privacy-publication-gate.test.ts --timeout=60000 -t 'unclosed regex classes: all sources stay bounded' | 1 |

CPU profiles and focused regex matrices each exited 0. Profiles used
`gate-remote --get PROFILE --out SCRATCH -- bun --cpu-prof --cpu-prof-name=PROFILE --cpu-prof-dir=. -e PROGRAM`.
The matrices used `gate-remote -- bun -e PROGRAM`. Inputs were the same escaped
quote and regex-class shapes as the bounded tests, at 3200/25600 escape pairs
or 1600/12800 class openers. Paired probes alternated small and large inputs.
No general wall-time improvement is claimed.

## Shared-fixture comparison

An additional complete run of `src/lib/monitor/seatTickController.agenda.test.ts`
used refreshed main `3dffc54e145fcba779e3ec82fdcff53030728da3` and the branch,
with the same isolated command:

```sh
gate-remote -- bun test src/lib/monitor/seatTickController.agenda.test.ts --timeout=60000
```

Main: 68 pass / 14 fail, exit 1. Branch: 70 pass / 12 fail, exit 1.
Comparing every failing test name found zero new failures, exit 0. The fixture
repair recovers the gone-host stall case and the unobserved-turn Copilot gap case.
The agenda test file is unchanged. Its twelve inherited failures remain outside
this task's requested test files. The optional sibling-file campaign stopped
after this completed comparison; the other four sibling files were not run.

## Publication repair

Publication of `da0569312` identified a new failure in the runtime-selection
test when the pinned generator was absent. Its initial unconfigured lookup
ran before the refusal cases. Earlier full-suite checks provisioned the real
generator and therefore missed this dependency.

The selection test now creates private executable version responders through
the existing tool-fixture helper. It checks the selected executable by absolute
and relative path, rejects a fixed wrong version and a missing executable, and
retains the current-interpreter check. Fixture teardown removes its directory.
Production runtime selection and real generator integration tests are unchanged.

```sh
gate-remote -- env -u LLV_PRIVACY_GENERATOR_BUN bun test scripts/privacy-publication-gate.test.ts -t 'the configured generator runtime must match the provenance pin'
```

Accepted commit: exit 1, zero pass / one fail, requiring the missing pinned
runtime. Repair: exit 0, one pass / zero fail, five assertions. Both runs used
native Bun 1.4.0 with the same isolation and no generator configuration.

## Privacy tool provisioning

Run inside the remote command's isolated temporary root, then execute the
privacy test command. The native test interpreter remains Bun 1.4.0.

```sh
set -euo pipefail
verification_root=$PWD
private_tools=$(mktemp -d "$TMPDIR/privacy-tools-XXXXXX")
cd "$private_tools"
curl -fsSL https://github.com/oven-sh/bun/releases/download/bun-v1.3.3/bun-linux-x64.zip -o bun-linux-x64.zip
curl -fsSL https://github.com/oven-sh/bun/releases/download/bun-v1.3.3/SHASUMS256.txt -o SHASUMS256.txt
sha256sum --check --ignore-missing SHASUMS256.txt
unzip -q bun-linux-x64.zip
apt-get download tesseract-ocr tesseract-ocr-eng tesseract-ocr-osd \
  libtesseract5 liblept5 libarchive13t64 libpangocairo-1.0-0 \
  libopenjp2-7 libgif7 libwebpmux3 libpangoft2-1.0-0 libxml2 libnettle8t64
mkdir deps
for package in *.deb; do dpkg-deb -x "$package" deps; done
export PATH="$private_tools/deps/usr/bin:$PATH"
export LD_LIBRARY_PATH="$private_tools/deps/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export TESSDATA_PREFIX="$private_tools/deps/usr/share/tesseract-ocr/5/tessdata"
export LLV_PRIVACY_GENERATOR_BUN="$private_tools/bun-linux-x64/bun"
ldd "$private_tools/deps/usr/bin/tesseract"
tesseract --version
"$LLV_PRIVACY_GENERATOR_BUN" --version
cd "$verification_root"
bun test scripts/privacy-publication-gate.test.ts --timeout=60000
```

## Deterministic literal-matching comparison

The first probe exited 1 and found the overlapping `--` opener difference.
The corrected reader returned 40,000 matching token streams, exit 0,
with seed `56ec2fb7`. Corpus SHA-256:
`968a5ffe86f57127a1c642da597c7de6ccf1057982aea05cdcb9ff2571305e58`.

Execute the following JavaScript with `gate-remote -- bun -e PROGRAM`.
It reads the original expressions from the pinned base and compares both
source-token and raw-token modes, including malformed and Unicode input.

```js
import fs from "node:fs";import crypto from "node:crypto";
const current=fs.readFileSync("scripts/privacy-publication-gate.ts","utf8");
const base=Bun.spawnSync(["git","show","adce5764927f7e838f20070cd2968128912e861c:scripts/privacy-publication-gate.ts"]).stdout.toString();
const oldLine=base.split("\n").find(x=>x.startsWith("  const literals = text.matchAll("));
const oldPattern=Function("return "+oldLine.slice(oldLine.indexOf("matchAll(")+9,-2))();
const rawLine=base.split("\n").find(x=>x.startsWith("  const rawQuotePattern = "));
const rawPattern=Function("return "+rawLine.slice(rawLine.indexOf("= ")+2,-1))();
const begin=current.indexOf("  const regexContext = ");
const end=current.indexOf("  const literals = literalMatches();",begin);
const translated=new Bun.Transpiler({loader:"ts"}).transformSync(current.slice(begin,end)+"\nreturn [...literalMatches(text, comments)].map(m=>[m.index,m[0]]);");
const tokenize=Function("text","comments",translated);
let state=0x56ec2fb7;
const next=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};
const atoms=["return","throw","case","yield","else","foo",".","++","--","//","/*","*/","\\","[","]",'"',"'",String.fromCharCode(96),"\n"," ","\r",";",":",",","(",")","#","&","?","\0","😀","\u2028","\ud800"];
const digest=crypto.createHash("sha256");let comparisons=0;
for(let n=0;n<20000;n++){
 let text="";for(let i=next()%40;i>=0;i--)text+=atoms[next()%atoms.length];
 digest.update(JSON.stringify(text));
 for(const comments of [true,false]){
  const pattern=comments?oldPattern:rawPattern;pattern.lastIndex=0;
  const expected=[...text.matchAll(pattern)].map(m=>[m.index,m[0]]);
  const actual=tokenize(text,comments);comparisons++;
  if(JSON.stringify(expected)!==JSON.stringify(actual)){console.log(JSON.stringify({case:n,comments,text,expected,actual}));process.exit(1);}
 }
}
console.log(JSON.stringify({seed:"56ec2fb7",comparisons,corpusSha256:digest.digest("hex"),mismatches:0}));

```


## Final checks on the refreshed tree

All five requested retained test files were rerun after the main refresh:
106 controller tests, 643 privacy tests and 48 route tests passed, each command
exiting 0. The privacy command uses the provisioning procedure above.

Commands below omit the transparent RTK log proxy.

| Command | Exit | Result |
| --- | ---: | --- |
| gate-remote -- bun x tsc --noEmit | 0 | Full typecheck |
| bun x eslint (the eight retained TypeScript files) | 0 | No lint findings |
| git diff --check | 0 | No whitespace errors |
| publication privacy command below | 0 | PRIVACY GATE: PASS |
| gate-remote -- env LLV_PRIVACY_TEST_QUADRATIC=1 bun test scripts/privacy-publication-gate.test.ts --timeout=60000 -t 'unclosed double quotes: all sources stay bounded' | 1 | Expected red control: 40.91x CPU growth exceeds unchanged 32x limit |

Exact ESLint file selection:

```sh
bun x eslint scripts/privacy-generator-runtime.ts scripts/privacy-publication-gate.ts \
  scripts/privacy-publication-gate.test.ts src/lib/monitor/seatTickController.fixture.ts \
  src/lib/monitor/seatTickController.test.ts src/app/api/bridge/route.test.ts \
  src/app/api/orchestrator/reports/route.test.ts \
  src/app/api/monitor/seat-tick/settings/route.test.ts
```

Publication privacy command:

```sh
LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE=scripts/privacy-known-value-fingerprints.json \
  bun scripts/privacy-publication-gate.ts --require-known-values --paths \
  docs/privacy-publication.md docs/verification/cloud-test-fixes.md \
  scripts/privacy-generator-runtime.ts scripts/privacy-publication-gate.ts \
  scripts/privacy-publication-gate.test.ts src/lib/monitor/seatTickController.fixture.ts \
  src/lib/monitor/seatTickController.test.ts src/app/api/bridge/route.test.ts \
  src/app/api/orchestrator/reports/route.test.ts \
  src/app/api/monitor/seat-tick/settings/route.test.ts
```

Self-review found no unresolved defect in the retained changes. No assertion
limit or private-value exemption was relaxed. Workflow files are unchanged.
Commit-hook and post-commit privacy outcomes are recorded in the stage report.

The plain result-13 `git commit` exited 0. Its staged-whitespace, privacy and
ESLint hooks all passed. The result-17 commit uses the same enabled hooks.
