# Claude login and native Codex CI flakes

The first attempts of [macOS process identity](https://github.com/Latand/delegatus/actions/runs/38606908738/job/116000141098)
and [native Codex 0.154.0](https://github.com/Latand/delegatus/actions/runs/38608777716/job/116006423947)
failed on PR #2863. Read their original job logs: the run-level failed-log view
changes after a rerun.

## Causes and fixes

`src/lib/accounts/claudeLogin.test.ts:154` on base armed an 8 ms timer in a
foreign process and expected synchronous persistence at line 156. The timer
starts when that process next observes the release file. Scheduling, filesystem
work and lock release can exceed the 25 ms admission budget in
`src/lib/accounts/accountMutation.ts:19`. `ClaudeLoginSupervisor.persist`
(`src/lib/accounts/claudeLogin.ts:356`) then correctly queues the latest state.
The macOS log received `awaiting_browser` after 398 ms, and the Linux reproduction
received the identical mismatch. This is a test timing assumption.

The synchronous case now controls the admission clock and releases the actual
foreign holder on the first lock wait. It requires real contention and a saved
`awaiting_code` before stdout emission returns. A real-clock watchdog bounds the
controlled case. A second test holds the foreign lock throughout synchronous
admission, checks the live phase and absence of kill signals, then waits for the
save callback after release. An explicit rejection timer makes a missing save
fail and reach cleanup. The existing admission-budget test still checks the
25 ms cap with the real clock.

The Codex failure came from `stopFixtureTree`,
`src/lib/testing/fixtureProcess.ts:66` on base, at the first server's cleanup
(`src/lib/runtime/codexAppServerHost.injectCli.test.ts:133`). It threw after
908 ms with a 2 s cleanup budget. Repeated independent kernel reads can observe
a zombie as exited, then read its start token just before reaping and get an
absent stat record afterwards. The Linux `processExited` reader returns false
for an absent record (`src/lib/proc/linux.ts:66`), so rescanning the complete
original membership can report that already-exited process as alive again.
This is a race in the shared test fixture, with a controlled reproduction of
the same premature survivor error.

Cleanup now removes terminal members from its remaining set permanently. It
keeps the signal identity checks, escalation, deadline and final root-handle
reaping. Temporarily unverified members remain available for later checks; a
separate regression requires escalation once their identity is verified again. The regression controls those kernel readings and checks that an
observed exit cannot trigger another signal or another liveness read. The
native restart test keeps all full/restricted sandbox and approval assertions.

## Measured failure rates

Base is `3050c102786bf47c461bf0eb614286563760478e`. Each sample uses a fresh
`bun test` process through `scripts/gate-slot.sh`, with isolated HOME, XDG,
TMPDIR and LLV_STATE_DIR. Linux measurements use Bun 1.4.0; the original macOS
job used Bun 1.3.3. This machine cannot run macOS.

| Check | Base failures | Fixed failures |
| --- | --- | --- |
| Claude synchronous persistence, descheduled foreign holder | 4/50 (8%) | 0/50 (0%) |
| Controlled zombie/reaping readings in the shared cleanup helper | 50/50 (100%) | 0/50 (0%) |
| Real Codex 0.154.0 succession under CPU contention | 0/50 (0%) | 0/50 (0%) |
| Claude deferred persistence, descheduled foreign holder | New test | 0/50 (0%) |

Claude base failures were samples 5, 12, 36 and 48. All had the original
`awaiting_browser` versus `awaiting_code` mismatch. The native CPU campaign
did not reproduce the rare race on base; the controlled helper campaign supplies
the failing reproduction. Native Codex attempt 1 failed and attempt 2 passed
on the same CI head. These are observed rates for the specified stimuli.

The native checks exercise credential-free **Codex app-server processes**, with
both server generations and both access policies. The executable is the same
Rust binary under `@openai/codex-linux-x64/vendor/` that CI calls. The complete
native file also passes on 0.154.0 and 0.159.0. The two touched files pass (46 Claude tests,
10 fixture tests), as does the explicit real-clock admission-cap test.

## Repeat the campaigns

Create a private scratch directory, set FLAKE_ROOT to its absolute path, and
create home, config, tmp, state and logs children. Install `@openai/codex@0.154.0`
under its codex154 child. Save the following as `stress.py` there. Each sample's
full log and exit result are retained; no failed sample becomes a passing one
through retry.

```python
import os, subprocess, sys, pathlib, json
root=pathlib.Path(__file__).parent
label, file, name, count=sys.argv[1:]
count=int(count)
env=os.environ.copy()
env.update(HOME=str(root/'home'), XDG_CONFIG_HOME=str(root/'config'), TMPDIR=str(root/'tmp'), LLV_STATE_DIR=str(root/'state'), LLV_CODEX_BINARY=os.environ.get('FLAKE_CODEX_BINARY', str(root/'codex154/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex')))
# Keep load in the owned scope; preloads select each tested process's CPU.
cpu=min(os.sched_getaffinity(0)); os.sched_setaffinity(0,{cpu})
load=subprocess.Popen(['python3','-c','while True: pass'],env=env)
results=[]
try:
 for i in range(count):
  args=['bash','scripts/gate-slot.sh','bun','test',file,'-t',name]
  if os.environ.get('FLAKE_PRELOAD'): args += ['--preload',os.environ['FLAKE_PRELOAD']]
  result=subprocess.run(args,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
  (root/'logs'/f'{label}-{i+1:03}.log').write_text(result.stdout)
  row={'run':i+1,'exit':result.returncode,'pass':result.returncode==0}
  results.append(row)
  print(json.dumps(row),flush=True)
finally:
 load.terminate(); load.wait(timeout=5)
 (root/'logs'/f'{label}-summary.json').write_text(json.dumps({'file':file,'filter':name,'N':count,'failed':sum(not r['pass'] for r in results),'cpu':cpu,'results':results},indent=2))
```

For the Claude scheduling campaign, save this as `holder-descheduled.ts` in
the scratch directory. Only the fixture child recorded at spawn is adjusted.
The busy worker runs on CPU 0, the test caller on CPU 1, and the foreign holder
on CPU 0 at nice 19. Choose two available CPUs if this host numbers them
differently, using the same choices on base and head.

```typescript
import os from "node:os";
import { spawnSync } from "node:child_process";
if (spawnSync("taskset", ["-pc", "1", String(process.pid)]).status !== 0) throw new Error("could not pin caller");
const spawn = Bun.spawn;
Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
  const child = Reflect.apply(spawn, Bun, args);
  const options = args[0] as { cmd?: string[] };
  if (options.cmd?.some(arg => arg.includes("foreign fixture writer"))) {
    if (spawnSync("taskset", ["-pc", "0", String(child.pid)]).status !== 0) throw new Error("could not pin holder");
    os.setPriority(child.pid, 19);
  }
  return child;
}) as typeof Bun.spawn;
```

Run these commands from the checkout, with HOME, XDG_CONFIG_HOME, TMPDIR and
LLV_STATE_DIR set to the scratch children:

```sh
FLAKE_PRELOAD="$FLAKE_ROOT/holder-descheduled.ts" bash scripts/gate-slot.sh \
  python3 "$FLAKE_ROOT/stress.py" claude src/lib/accounts/claudeLogin.test.ts \
  'short foreign holder' 50
bash scripts/gate-slot.sh python3 "$FLAKE_ROOT/stress.py" cleanup \
  src/lib/testing/fixtureProcess.test.ts 'keeps an observed exit terminal' 50
```

Apply the added cleanup regression to the base helper to obtain its red
measurement. For the native campaign use the real succession test and pin the
test caller to CPU 0 in a preload (the busy worker also runs on CPU 0). For the
new deferred campaign select `deferred stdout transition after a foreign holder`
with the same holder preload. The test preload itself must apply affinity:
the owned runner creates a new service, which can reset affinity inherited
from a shell. Avoid `--rerun-each`; repeated global preload teardown introduces
unrelated missing-ledger errors in this repository.
