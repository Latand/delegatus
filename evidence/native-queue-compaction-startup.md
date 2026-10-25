# Native queue compaction startup verification

Verification date: 2026-10-23. The complete file is
`src/lib/runtime/nativeQueueCompaction.integration.test.ts`.

## Cause and repair

The publication refusal reports `initialize timed out`, before the native
queue recovery assertions execute. This fixture supplied
`requestTimeoutMs: 1000` to the real app-server. The production default in
`src/lib/runtime/codexAppServerHost.ts` is 30 seconds. A two-second startup
delay reproduces the same refusal on main and the refused head in every trial.
Ordinary whole-file runs pass on both revisions.

The fixture now uses the production RPC deadline and a 60-second whole-test
bound. Every assertion, polling predicate and cleanup statement is unchanged.
The missing-evidence case still preserves both entries; canonical evidence
still settles only the dispatched entry; the undispatched entry remains
queued; recovery still writes nothing to the engine. A byte comparison against
main confirmed the only changes are the RPC override, explanatory comment and
whole-test bound. The source repair matches the overlapping publication repair
in `dc1ef2c09`, whose actual diff was read before editing.

## Procedure

All observations used Bun 1.4.0 and `gate-remote`, one call at a time. Main and
the refused head ran from disposable detached clones with the same origin.
Every trial created fresh private HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and
TMPDIR beneath the runner's private temporary root, with LLV_VIEWER_CONTROL_URL
set to a closed loopback port. The repository preload, child supervision and
fixture's isolated local Responses backend remained enabled. No live state or
external model service was used.

Each remote shell loop executed this command with the chosen fixture binary,
printed a result line per trial and ended with an explicit completed-run count:

```sh
setsid env HOME="$TRIAL/home" XDG_CONFIG_HOME="$TRIAL/config" \
  LLV_STATE_DIR="$TRIAL/state" TMPDIR="$TRIAL/tmp" \
  LLV_VIEWER_CONTROL_URL="$CLOSED_CONTROL_URL" \
  NATIVE_CODEX_QUEUE_TEST_BINARY="$CODEX_FIXTURE" \
  bun test src/lib/runtime/nativeQueueCompaction.integration.test.ts </dev/null
```

No test-name filter was used. Startup-control wrappers delayed only the actual
`app-server --enable realtime_conversation` launch. Version, feature and schema
probes forwarded immediately, and the wrapper then used `exec` with unchanged
arguments. The delayed control waited two seconds; the stuck control withheld
startup for 45 seconds, beyond the production RPC deadline. These controls
changed only scratch wrappers, never product source or the test assertions.

## Whole-file outcomes

Main was fetched before the comparison: `f348d75bd0012871867ebc63908a69b7b9e65b1c`.
The refused head is `5dea4d29`. Their test file bytes are identical.
The fixed test blob is `bb8229a29f23e5f29c0ac92a33fa7d118777714b`.

| Revision / startup | Codex | Runs | Whole-file exit codes |
| --- | --- | ---: | --- |
| Main, ordinary | 0.162.1 | 3 | 0, 0, 0 |
| Refused head, ordinary | 0.162.1 | 3 | 0, 0, 0 |
| Main, two-second delay | 0.162.1 | 3 | 1, 1, 1: `initialize timed out` |
| Refused head, two-second delay | 0.162.1 | 3 | 1, 1, 1: `initialize timed out` |
| Fixed, ordinary | 0.154.0 | 3 | 0, 0, 0 |
| Fixed, ordinary | 0.159.0 | 3 | 0, 0, 0 |
| Fixed, ordinary | 0.162.1 | 3 | 0, 0, 0 |
| Fixed, ordinary | 0.163.0 | 3 | 0, 0, 0 |
| Fixed, two-second delay | 0.162.1 | 3 | 0, 0, 0 |
| Fixed, stuck startup | 0.162.1 | 1 | 1: expected `initialize timed out` |

Every successful whole-file observation reports two passed tests, zero failed
tests and 37 assertions. Every delayed-start reproduction reports one passed
registry test and one failed real-Codex test at initialization. All completed
loop counts match their requested trial counts.

The stuck-start control also reports one passed registry test and one failed
real-Codex test, at the production RPC deadline. Supervised cleanup completes
within the whole-test bound. Across this source-blob campaign, main and the
refused head each have three ordinary passes and three expected delayed-start
failures. The fixed source has 15 passes and one expected timeout-control
failure. Final committed-head confirmations are reported separately in the
stage summary.


## Dispatch wait verification (2026-10-25, Europe/Kyiv)

Pinned main: `0c7f7a894ce3a4d4ff2b99fb806f837192f403f3`.
Current main checked during verification: `61a93e693679a6c58f3465829b7a379a858b4185`.
Fixed test blob: `971fad14c7a0badd3561740f5faf66cc7742b057`.
Bun 1.4.0, Linux, 24 online CPUs, real Codex 0.162.1 and the local Responses
backend. The four-version matrix also covers 0.154.0, 0.159.0 and 0.163.0.

#3309 removed a one-second RPC override. It left a separate five-second
progress wait in the fixture. Delaying the HTTP backend listener by 6.5 seconds
makes main fail at that wait before it can test recovery. The fixed fixture
uses the production 30-second RPC budget for progress too, and identifies the
awaited event in a timeout. The 60-second whole-test limit, recovery predicates,
all 37 assertions and owned cleanup remain unchanged.

This proves a remaining false-failure boundary. Ordinary main runs have passed;
these observations do not attribute every historical publication refusal to
this boundary. The retained refusal from one reported lane says initialization
timed out, and the other lane later refused a different native test.

The restart removed the earlier scratch logs. The following fresh whole-file
observations replace the interrupted attempt's checkpoint. Every trial used
checkEnvironment followed by isolatedEnvironment, with private HOME, all XDG
roots, TMPDIR and LLV_STATE_DIR, and a closed Viewer control URL. Each trial
started a new Bun process and real native executable. No operator state or
external model service was used. Heavy checks ran locally, one at a time,
through the installed gate wrapper.

### Fresh whole-file results

Load is the one-minute OS average, sampled before and after each trial.
The contention campaign starts 16 owned CPU workers, waits for load 24–45,
and requires every trial's samples to remain in 20–50. It uses the gate's
supported 1200% per-command CPU quota under the unchanged aggregate work cap.
Pinned and current main and both fixed fixtures run sequentially under those
same workers. Baseline and fixed delayed trials follow under the same workers.
Every worker is stopped by its recorded child handle and awaited in finally.

| Campaign | Completed | Failures | Failure rate | Load range | Exit codes |
| --- | ---: | ---: | ---: | --- | --- |
| base-natural | 10/10 | 0/10 | 0% | 11.97–11.97 | 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 |
| base-delayed | 10/10 | 10/10 | 100% | 10.54–12.86 | 1, 1, 1, 1, 1, 1, 1, 1, 1, 1 |
| fixed-natural | 10/10 | 0/10 | 0% | 10.27–10.54 | 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 |
| fixed-delayed | 10/10 | 0/10 | 0% | 9.69–10.83 | 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 |
| matrix-0.154.0 | 3/3 | 0/3 | 0% | 10.83–11.97 | 0, 0, 0 |
| matrix-0.159.0 | 3/3 | 0/3 | 0% | 11.97–11.97 | 0, 0, 0 |
| matrix-0.163.0 | 3/3 | 0/3 | 0% | 11.65–11.97 | 0, 0, 0 |
| base-load | 10/10 | 0/10 | 0% | 24.67–28.36 | 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 |
| fixed-load | 10/10 | 0/10 | 0% | 28.36–30.37 | 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 |
| latest-base-load | 10/10 | 0/10 | 0% | 30.37–31.50 | 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 |
| latest-fixed-load | 10/10 | 0/10 | 0% | 31.06–33.81 | 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 |
| base-load-delayed | 10/10 | 10/10 | 100% | 29.95–34.67 | 1, 1, 1, 1, 1, 1, 1, 1, 1, 1 |
| fixed-load-delayed | 10/10 | 0/10 | 0% | 24.23–31.38 | 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 |
| final-file | 1/1 | 0/1 | 0% | 16.56–16.56 | 0 |

All successful runs report two passing tests and 37 assertions without skips.
Delayed baseline failures report one passing registry test, one failing native
test and 21 assertions; each expires at the first-model-request progress wait.
The delayed comparison uses the same preload and executable on both revisions.
Both main revisions have identical bytes for the test, native executor, host,
manifest and lockfile. No open PR touched the changed files when checked.
A preliminary 32-worker campaign also passed 30 whole-file trials. Its guard
refused the comparison when load reached 50.74 during the current-main group;
those extra observations are excluded from the table. Its pinned-main ten
trials ranged 31.39–42.88 and fixed ten ranged 42.88–49.72, all passing.
The final 16-worker campaign replaces it.
The only changed executable file is this test, which has no importing modules.
The native verification script selects it by filename and runs the same file.

### Failure controls and required checks

Controls run in scratch only and restore the tested fixture afterwards.

- Keep canonical proof hidden: recovery must expire at its named wait. Expected exit 1, observed exit 1; elapsed 30.99 seconds.
- Issue a real native queue reorder: the no-engine-write assertion must fail. Expected exit 1, observed exit 1; elapsed 0.97 seconds.
- Withhold app-server startup: initialization must expire within its RPC budget. Expected exit 1, observed exit 1; elapsed 30.62 seconds.
- `bun x tsc --noEmit`: exit 0.
- `bun x eslint src/lib/runtime/nativeQueueCompaction.integration.test.ts`: exit 0.
- Privacy gate with committed known-value fingerprints and both touched paths: exit 0.

### Reproduction commands

`SCRATCH` is the stage-owned temporary root, `SOURCE` the assigned worktree,
and `GATE_SLOT` the installed wrapper supplied to the stage. Create detached
scratch clones named `base` and `fixed` at pinned main, and `latest-base` and
`latest-fixed` at current main. Pin each clone's HEAD and origin/main to its
reviewed revision, and verify a clean tracked tree before applying the fixed
fixture. Copy only the final test from SOURCE into the two fixed trees.
Use dependencies whose manifest, lockfile and installed versions match.

Save the following as `$SCRATCH/campaign-ready.ts`; copy it to
`$SCRATCH/campaign.ts` for the ordinary command. Its `config.json` contains a
`bins` object mapping the four version strings to their absolute cached native
executables. This uses each real executable with the fixture's local backend.

```ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const root = path.dirname(import.meta.path);
const config = JSON.parse(fs.readFileSync(path.join(root,"config.json"),"utf8"));
const { checkEnvironment } = await import(path.join(root,"fixed/scripts/gate-cache.ts"));
const { isolatedEnvironment } = await import(path.join(root,"fixed/scripts/local-gate.ts"));
const file = "src/lib/runtime/nativeQueueCompaction.integration.test.ts";
const clean = checkEnvironment(process.env);
const rows: any[] = [];
fs.mkdirSync(path.join(root,"results"),{recursive:true});
async function trial(tree: string,label: string,i: number,binary: string,preload?:string,expected?:string) {
 const env=isolatedEnvironment(path.join(root,"results",label,String(i)),clean);
 env.NATIVE_CODEX_QUEUE_TEST_BINARY=binary;
 env.LLV_OWNED_RUN_TIMEOUT_MS="180000";
 const log=path.join(root,"results",`${label}-${i}.log`), fd=fs.openSync(log,"w");
 const start=Date.now(), loadBefore=os.loadavg();
 const args=["setsid","--wait",process.execPath,"run","test",...(preload?["--preload",preload]:[]),file];
 const child=Bun.spawn(args,{cwd:path.join(root,tree),env,stdin:"ignore",stdout:fd,stderr:fd});
 const code=await child.exited;fs.closeSync(fd);
 const output=fs.readFileSync(log,"utf8");
 const row={label,i,code,ms:Date.now()-start,loadBefore,load:os.loadavg(),pass:Number(output.match(/\n (\d+) pass/)?.[1]),fail:Number(output.match(/\n (\d+) fail/)?.[1]),assertions:Number(output.match(/\n (\d+) expect\(\) calls/)?.[1])};
 rows.push(row);fs.writeFileSync(path.join(root,"results/rows.json"),JSON.stringify(rows,null,2));
 console.log(JSON.stringify(row));
 if(expected) {console.log(output);if(code!==1||!output.includes(expected))throw Error(`Control did not refuse as intended: ${label}`);}
 else if(code!==0||row.pass!==2||row.fail!==0||row.assertions!==37||/\n \d+ skip/.test(output)){console.log(output);throw Error(`Incomplete or failed trial: ${label}`);}
}
async function repeat(tree:string,label:string,count:number,binary:string,preload?:string,expected?:string) {
 for(let i=1;i<=count;i++)await trial(tree,label,i,binary,preload,expected);
 console.log(JSON.stringify({label,completed:count,failures:rows.filter(r=>r.label===label&&r.code!==0).length}));
}
const binary=config.bins["0.162.1"];
const mode=process.argv[2]??"ordinary";
if(mode==="ordinary") {
 await repeat("base","base-natural",10,binary);
 await repeat("base","base-delayed",10,binary,path.join(root,"delay.preload.ts"),"native fixture deadline");
 await repeat("fixed","fixed-natural",10,binary);
 await repeat("fixed","fixed-delayed",10,binary,path.join(root,"delay.preload.ts"));
 for(const version of ["0.154.0","0.159.0","0.163.0"])await repeat("fixed",`matrix-${version}`,3,config.bins[version]);
} else if(mode==="load") {
 const env=isolatedEnvironment(path.join(root,"load-workers"),clean);
 const workers=Array.from({length:16},()=>Bun.spawn(["python3","-c","while True: sum(i*i for i in range(10000))"],{env,stdin:"ignore",stdout:"ignore",stderr:"inherit"}));
 try {
  const deadline=Date.now()+300000;
  while(os.loadavg()[0]<24||os.loadavg()[0]>45) {
   console.log("WARMUP",JSON.stringify(os.loadavg()));
   if(Date.now()>deadline)throw Error("load warmup deadline");
   await Bun.sleep(5000);
  }
  for(const tree of ["base","fixed","latest-base","latest-fixed"]) {
   const label=tree+"-load";
   await repeat(tree,label,10,binary);
   if(rows.some(r=>r.label===label&&(r.load[0]<20||r.load[0]>50||r.loadBefore[0]<20||r.loadBefore[0]>50)))throw Error(`Load outside 20-50: ${label}`);
  }
  await repeat("base","base-load-delayed",10,binary,path.join(root,"delay.preload.ts"),"native fixture deadline");
  await repeat("fixed","fixed-load-delayed",10,binary,path.join(root,"delay.preload.ts"));
  if(rows.some(r=>r.load[0]<20||r.load[0]>50||r.loadBefore[0]<20||r.loadBefore[0]>50))throw Error("Load outside 20-50 in delayed pair");
 } finally {for(const child of workers)child.kill("SIGTERM");await Promise.all(workers.map(child=>child.exited));}
} else if(mode==="checks") {
 const target=path.join(root,"fixed",file),original=fs.readFileSync(target,"utf8");
 try {
  fs.writeFileSync(target,original.replace("hideCanonicalClient = null;\n\n    await until", "hideCanonicalClient = dispatched.operationId;\n\n    await until"));
  await repeat("fixed","missing-proof",1,binary,undefined,"native fixture deadline waiting for canonical history");
  fs.writeFileSync(target,original.replace("hideCanonicalClient = null;\n\n    await until", "hideCanonicalClient = null;\n    await host.nativeQueue!.queue.reorder((await host.nativeQueue!.queue.refresh()).items!.map(item => item.id));\n\n    await until"));
  await repeat("fixed","extra-engine-write",1,binary,undefined,"thread/queue/reorder");
 } finally {fs.writeFileSync(target,original);}
 await repeat("fixed","stuck-start",1,path.join(root,"stuck-codex"),undefined,"initialize timed out");
 for(const [label,args] of [["typecheck",[process.execPath,"x","tsc","--noEmit"]],["eslint",[process.execPath,"x","eslint",file]]] as const) {
  console.log("START",label);const env=isolatedEnvironment(path.join(root,label),clean);
  const child=Bun.spawn([...args],{cwd:path.join(root,"fixed"),env,stdin:"ignore",stdout:"inherit",stderr:"inherit"});
  const code=await child.exited;fs.writeFileSync(path.join(root,`${label}.result.json`),JSON.stringify({label,code}));
  if(code!==0)throw Error(`${label} failed ${code}`);console.log("PASS",label);
 }
 await repeat("fixed","final-file",1,binary);
} else throw Error("unknown mode");
console.log("COMPLETE",mode,rows.length);
```

Save this controlled listener delay as `$SCRATCH/delay.preload.ts`:

```ts
import { mock } from "bun:test";
import * as http from "node:http";
const createServer=http.createServer;
mock.module("node:http",()=>({...http,createServer:(...args:any[])=>{
 const listener=args.pop(),timers=new Set<ReturnType<typeof setTimeout>>();
 const server=createServer(...args,(...event:any[])=>{const timer=setTimeout(()=>{timers.delete(timer);listener(...event)},6500);timers.add(timer)});
 server.once("close",()=>{for(const timer of timers)clearTimeout(timer)});return server;
}}));
```

For the startup refusal, `$SCRATCH/stuck-codex` is an executable wrapper which
sleeps 45 seconds only for the `app-server --enable realtime_conversation`
launch sequence after any config arguments, then execs Codex 0.162.1
with every original argument and stdin unchanged. Version and schema probes
forward immediately. The command-level watchdog supervises that process too.

After the ordinary campaign, preserve `results/rows.json` as
`ordinary-rows.json`. The actual outer commands, run sequentially, were:

```sh
LLV_GATE_RUNNER=off LLV_OWNED_RUN_TIMEOUT_MS=2400000 \
  bash "$GATE_SLOT" bun "$SCRATCH/campaign.ts" ordinary

LLV_GATE_RUNNER=off LLV_WORK_SCOPE_CPU_QUOTA=1200 \
  LLV_OWNED_RUN_TIMEOUT_MS=2400000 \
  bash "$GATE_SLOT" bun "$SCRATCH/finish-ready.ts"
```

The sequential batch driver was saved as `$SCRATCH/finish-ready.ts`:

```ts
import path from "node:path";
import fs from "node:fs";
const root=path.dirname(import.meta.path);
for(const mode of ["checks","load"]) {
 console.log("CAMPAIGN",mode);
 const child=Bun.spawn([process.execPath,path.join(root,"campaign-ready.ts"),mode],{stdin:"ignore",stdout:"inherit",stderr:"inherit"});
 const code=await child.exited;
 fs.copyFileSync(path.join(root,"results/rows.json"),path.join(root,`${mode}-rows.json`));
 if(code!==0)throw Error(`${mode} failed ${code}`);
}
console.log("FINAL BATCH COMPLETE");
```

`finish-ready.ts` invokes `bun campaign-ready.ts checks`, then
`bun campaign-ready.ts load`, awaiting each exit before proceeding and
preserving the per-campaign JSON results. Each trial launches
`setsid --wait bun run test [--preload delay.preload.ts]` followed by the full
explicit test path with stdin closed. No test-name filter is used. The runner
requires 2 pass, 0 fail and 37 assertions for each successful observation,
checks every failure control's diagnostic, prints each completed count and
fails a batch on any unexpected result or out-of-range contention sample.

The privacy command ran from the fixed scratch tree in a fresh isolated
environment, with the committed fingerprint file selected:

```sh
bun scripts/privacy-publication-gate.ts \
  --base 0c7f7a894ce3a4d4ff2b99fb806f837192f403f3 \
  --require-known-values --check-commits --paths \
  src/lib/runtime/nativeQueueCompaction.integration.test.ts \
  evidence/native-queue-compaction-startup.md
```

Self-review confirmed that all assertion statements and the native test's
finally block are byte-identical to pinned main. Workflows are untouched.
