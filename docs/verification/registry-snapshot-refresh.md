# Registry snapshot refresh on current main

Measured on 2026-10-13 from main at
`8f103d02ec68ecae135c5a60d8bb14430ca207b7`, on the same machine and in the same
session as the verification below. No timing from the interrupted lane is
used here.

## What step one found

The requested dependency tracking had already landed in #2762
(`8f1cfd53081315f07780328c46e0d9c2278a153e`). This branch adds regression
coverage and measurements. It changes no product source and claims no new
speed-up over its starting main.

In `src/lib/agent/sqliteRegistryStore.ts` at the measured revision:

- Lines 1239–1250 record dependencies while loading hot grant-bearing rows.
- Lines 1334–1504 implement the incremental snapshot refresh.
- Lines 1353–1359 collect the grant rows reached by changed dependencies.
- Lines 1405–1424 handle changed attestors, newly appearing generation/path
  identities and launch lineage, and the changed grant-bearing rows themselves.
- Lines 1426–1463 re-decide those rows from stored claims. The complete-load
  fallback establishes tracking once if the previous load had none.
- Lines 1510–1559 record attestor reads, including absent rows and identity
  searches. A trimmed journal still takes the complete loader.

The reported 150–225 ms per refresh did not reproduce in the initial
diagnostic. Medians were 3.2–4.0 ms. Foreign conversation writes re-decided
3 rows at the median, receipts 2, and entries 1. The all-hot diagnostic
control below exercises the old breadth using the existing fallback.

## Method

Bun 1.4.0, Linux x64, Next.js 16.3.8, a fresh production build, and the
candidate gate's unchanged full dataset: 30,036 rows, 27,836 cold rows,
320 transcripts and eight projects. Every command enters `scripts/gate-slot.sh`
with its default three-CPU, 8 GiB service limits. Every check has private
HOME, XDG configuration/cache, TMPDIR and LLV_STATE_DIR, with
`LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`.

The refresh diagnostic alternates conversation, receipt and entry writes,
then times `readOnlySnapshot()`. It discards ten mixed warmup rounds and
records 100 samples per kind for a second SQLite connection and for the
reader's own connection. Receipts change `clientAttemptId`; conversations
and entries change `updatedAt`. Every returned field is checked. Timing
includes revision checking and snapshot refresh; deferred collection access
is checked after the timer stops. A wrapper counts `decideStoredRow` calls.
A 10 ms timer samples lateness over each mode, including warmup.

The full gate runs two Viewer releases, four live workers through succession,
concurrent writers, eight board scopes, the real runtime-host client, and
eight Chromium views of the production server. The warm limits remain
p95 ≤ 50 ms and max ≤ 500 ms. Browser opening has a separate 1,000 ms
server-loop limit; warm projection builds have a 2,000 ms maximum.

The first five runs could not launch Chromium: the diagnostic sandbox's
temporary path exceeded Chromium's Unix socket path limit. A separate launch
probe reproduced `Socket path too long` and passed with a short, private
browser TMPDIR. The full series was repeated with that correction, retaining
the first series separately as incomplete browser evidence. Product code,
gate workload and acceptance bounds stayed unchanged.

## Initial refresh measurements

| Writer | Row | p50 ms | p95 ms | Max ms | Decisions p50 / max |
| --- | --- | ---: | ---: | ---: | ---: |
| Second connection | conversations | 3.698 | 5.648 | 10.94 | 3 / 15 |
| Second connection | receipts | 3.37 | 5.349 | 8.592 | 2 / 3 |
| Second connection | entries | 3.175 | 4.939 | 7.721 | 1 / 1 |
| Same connection | conversations | 4.049 | 8.306 | 24.567 | 3 / 15 |
| Same connection | receipts | 3.806 | 8.438 | 35.059 | 2 / 3 |
| Same connection | entries | 3.288 | 10.144 | 40.025 | 1 / 1 |

The 10 ms diagnostic timer recorded p95/max lateness of 9.975/24.296 ms
for the second connection and 13.191/92.074 ms for the same connection.
The initial diagnostic overlapped the production build in a separate gate
service. The repeated diagnostic below is confirmation of the same product
code; differences between samples are not a speed-up introduced here.

## Repeated diagnostic and all-hot control

These were measured after the full-run series, in the same session and
through the same isolated runner. The product implementation is identical
before and after the added tests. The control forces the existing all-hot
fallback on every refresh; all other #2762 optimizations remain active.

| Mode | Writer | Row | p50 ms | p95 ms | Max ms | Decisions p50 / max |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Normal | Second connection | conversations | 5.443 | 9.235 | 23.524 | 3 / 15 |
| Normal | Second connection | receipts | 5.462 | 9.632 | 21.737 | 2 / 3 |
| Normal | Second connection | entries | 4.955 | 8.297 | 25.25 | 1 / 1 |
| Normal | Same connection | conversations | 4.6 | 7.798 | 11.142 | 3 / 15 |
| Normal | Same connection | receipts | 4.15 | 7.102 | 22.756 | 2 / 3 |
| Normal | Same connection | entries | 3.729 | 5.893 | 12.689 | 1 / 1 |
| All-hot control | Second connection | conversations | 14.655 | 22.433 | 32.424 | 88 / 88 |
| All-hot control | Second connection | receipts | 14.007 | 20.642 | 27.05 | 88 / 88 |
| All-hot control | Second connection | entries | 4.061 | 6.349 | 8.311 | 1 / 1 |
| All-hot control | Same connection | conversations | 16.245 | 20.933 | 44.527 | 88 / 88 |
| All-hot control | Same connection | receipts | 15.481 | 21.17 | 27.416 | 88 / 88 |
| All-hot control | Same connection | entries | 4.675 | 6.329 | 6.991 | 1 / 1 |

The normal diagnostic timer recorded p95/max lateness of 19.152/42.543 ms
for the second connection and 14.148/126.424 ms for the same connection.
The all-hot control recorded 25.273/53.024 ms and 26.478/55.226 ms respectively.
Each timer window includes its warmup rounds and both writes and refreshes.

### Remaining long-write cost

A separate instrumented full gate, excluded from the five normal runs,
timed `mutate`, `beginMutationWrite`, `refreshSnapshot`, `persistChanges`
and `refreshColdKeys` in the source store. It recorded wall time, process CPU
time and the service cgroup's throttled time for spans of at least 80 ms.

Its warm loop p95/max was 8.0/361.6 ms. The largest serving write in release A
took 342.9 ms, including 339.4 ms in `beginMutationWrite` and only 10.2 ms of
process CPU during that acquisition. The same wait occurred in the other
writer (347.4 ms). This is synchronous SQLite writer contention in
`sqliteRegistryStore.ts:2618`, outside dependency selection. The cgroup
also accumulated 37.7 ms of throttled time during the wait; that service-wide
counter cannot be subtracted as per-thread delay.

Source Viewer refresh spans in this traced run reached 193.2 ms. Their
journal size was not recorded, so the trace does not attribute every refresh
outlier. Its largest warm-loop stall aligns with the measured writer wait.
This preserves the distinction between a single-row refresh diagnostic and
the whole gate's work during release succession.

The traced full gate was refused for a 2165.9 ms warm projection and a
1298.5 ms server-loop delay while browser views opened. Those broader costs
remain outside this branch's refresh verification.

## Five complete gate runs

| Run | Warm Viewer p95 / max ms | Browser operating p95 / max ms | Browser opening max ms | Projection max ms | Full verdict |
| --- | ---: | ---: | ---: | ---: | --- |
| 1 | 8.9 / 182.7 | 8 / 63.8 | 1271.6 | 2268.4 | Refused |
| 2 | 7 / 277.3 | 7.8 / 83.8 | 1458.2 | 1661.7 | Refused |
| 3 | 7.6 / 208.2 | 3.1 / 100.3 | 952.3 | 2254.1 | Refused |
| 4 | 3.4 / 210.1 | 3.1 / 42.5 | 593.7 | 1080.5 | Pass |
| 5 | 3 / 207.5 | 4.5 / 75.4 | 846.7 | 1352 | Pass |

The largest warm Viewer delay, 277.3 ms, leaves 222.7 ms (44.5%) below
the 500 ms bound. All five runs have zero grant mismatches, write failures,
SQLite-busy failures and runtime-host timeouts. All four workers were
re-hosted and answering, with no lost or repeated progress.

The complete gate also checks work outside the refresh scope. Its refusals
are retained exactly:

- Run 1: warm projection build max 2268.4ms exceeds 2000ms.
- Run 1: server event-loop delay while the browser views opened 1271.6ms exceeds 1000ms.
- Run 2: server event-loop delay while the browser views opened 1458.2ms exceeds 1000ms.
- Run 3: warm projection build max 2254.1ms exceeds 2000ms.

### Preliminary runs with no browser measurement

These used the same source and full dataset. Each was refused because
Chromium could not launch. They are excluded from the complete-run series
above. They remain here to preserve every observation.

| Run | Warm Viewer p95 / max ms | Additional refusal |
| --- | ---: | --- |
| 1 | 5 / 147.2 | None |
| 2 | 8.1 / 237.8 | warm projection build max 2393.9ms exceeds 2000ms |
| 3 | 7.4 / 456.5 | warm projection build max 2090.1ms exceeds 2000ms |
| 4 | 6.3 / 498.4 | warm projection build max 2067.7ms exceeds 2000ms |
| 5 | 7.2 / 172.5 | warm projection build max 2881.7ms exceeds 2000ms |

The 498.4 ms preliminary sample coincided with a 471 ms grant-bearing
write in release A. That observation identifies the enclosing operation;
it does not establish that snapshot refresh consumed those 471 ms.

## Grant regression coverage

`src/lib/agent/sqliteRegistryStore.refresh.test.ts` checks both local commits
and commits from another connection. One refresh observes a conversation
write together with a receipt write. It compares the entry, receipt and
conversation grants with an independent complete snapshot, and checks that
an older held view keeps its original grant decision.

The tests exercise removal and restoration of a parent attestor, insertion
and removal of a contradictory generation owner, receipt grant revocation
and restoration, and removal and restoration of lineage evidence. Every
transition has an explicit allowed/denied assertion on the first refresh.
The metadata-only mixed writes also bound the number of decisions to nine.

This is coverage of the implementation already on main: the new tests pass
there. Negative controls temporarily remove parts of that implementation in
an isolated test process, then the unchanged implementation is run again.
These controls deliberately remove required behavior from the already
passing implementation.

### Negative controls

| Control in an isolated test process | Result | Observable failure |
| --- | --- | --- |
| Force the all-hot fallback | 2 failed, 2 passed | 73 decisions against the limit of 9 |
| Record no hot dependencies | 2 failed, 2 passed | Entry, receipt and conversation retain Telegram after parent removal |
| Omit generation/path/launch dependencies | 2 failed, 2 passed | Entry and receipt retain Telegram after a contradictory owner appears |
| Omit absent-row dependencies | 2 failed, 2 passed | Grants remain denied after the absent parent is restored |
| Omit receipt-row dependencies | 2 failed, 2 passed | Entry and conversation retain Telegram after receipt revocation alongside an unrelated conversation write |
| Omit lineage-row and launch dependencies | 2 failed, 2 passed | Grants remain allowed after the child's lineage is deleted |

The unchanged implementation then passed all four tests. The receipt case
uses an unrelated conversation: a parent restamp would also invalidate the
child and could mask missing receipt dependencies. The last two controls
and the final green run use that strengthened case.

### Focused checks

- Production build: passed, including its TypeScript check.
- New mixed-refresh suite: 4 passed, 100 assertions in the final run.
- Existing history suite: 10 passed.
- Read-only view suite: 16 passed.
- SQLite registry suite: 69 passed.
- Induced 600 ms slow-candidate rejection: 1 passed, 5 unrelated cases filtered.

Each test file ran by explicit path through `scripts/gate-slot.sh` under
fresh isolation. The complete gate results above are diagnostics and retain
their individual pass/refusal outcomes.

## Scope

The descriptor lifecycle and snapshot retention work in #2512 is unchanged.
The additional cases live in a separate refresh test file because that lane
also has history-test edits. Work stayed on the assigned branch. No live
registry, other worktree or deployment was modified.

## Reproduction

From the checkout, keep the installed Chromium executable and browser cache
available through `CHROME_BIN` and `PLAYWRIGHT_BROWSERS_PATH`. Use a short,
private temporary root for Chromium's socket. Each invocation below creates
fresh isolation; run the five complete measurements sequentially.

```sh
run_private() {
  check_root=$(mktemp -d /var/tmp/rr.XXXXXXXX)
  mkdir -p "$check_root/home" "$check_root/config" "$check_root/cache" "$check_root/state"
  env HOME="$check_root/home" XDG_CONFIG_HOME="$check_root/config" \
    XDG_CACHE_HOME="$check_root/cache" TMPDIR="$check_root" \
    LLV_STATE_DIR="$check_root/state" LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1 \
    bash scripts/gate-slot.sh "$@"
}
run_private bun install --frozen-lockfile
run_private bun run build
for run in 1 2 3 4 5; do
  run_private bun scripts/verify-viewer-runtime.ts --performance
done
run_private bun test src/lib/agent/sqliteRegistryStore.refresh.test.ts
run_private bun test src/lib/agent/sqliteRegistryStore.history.test.ts
run_private bun test src/lib/agent/sqliteRegistryStore.readOnlyView.test.ts
run_private bun test src/lib/agent/registry.sqlite.test.ts
run_private bun test src/runtime-host/candidatePerformanceRun.test.ts \
  --test-name-pattern 'an induced slow candidate'
```

Save this diagnostic outside the checkout and run it from the checkout with
`run_private bun <diagnostic.ts>`. Repeat with
`run_private env REFRESH_ALL_HOT=1 bun <diagnostic.ts>` to force the existing
all-hot fallback before each refresh. That control retains the other #2762
optimizations and measures current code with dependency selection disabled.

```ts
import fs from "node:fs";
import path from "node:path";

const checkout = process.cwd();
const { buildRegistryPerformanceDataset } = await import(path.join(checkout, "src/lib/agent/registryPerformanceDataset.ts"));
const { normalizeRegistry } = await import(path.join(checkout, "src/lib/agent/registry.ts"));
const { SqliteAgentRegistryStore } = await import(path.join(checkout, "src/lib/agent/sqliteRegistryStore.ts"));
const directory = fs.mkdtempSync(path.join(process.env.TMPDIR!, "mixed-refresh-"));
const dataset = buildRegistryPerformanceDataset(directory);
const open = () => new SqliteAgentRegistryStore(dataset.filename, {
  normalize: normalizeRegistry,
  initialSnapshot: () => { throw new Error("dataset missing"); },
});
const reader = open();
// Diagnostic control: take the existing fallback that re-decides every hot grant.
if (process.env.REFRESH_ALL_HOT === "1") {
  const originalRefresh = (reader as any).refreshSnapshot;
  (reader as any).refreshSnapshot = function(...args: any[]) {
    (reader as any).hotGrantsTracked = false;
    return originalRefresh.apply(this, args);
  };
}
const writer = open();
const kinds = ["conversations", "receipts", "entries"] as const;
const initial = reader.readOnlySnapshot().file;
const keys = {
  entries: dataset.activeEntryKeys,
  receipts: dataset.grantSubjects.filter((row: any) => row.collection === "receipts").map((row: any) => row.key),
  conversations: dataset.activeEntryKeys.map((key: string) => `conversation_${key.slice("codex:".length)}`),
};
for (const kind of kinds) if (!keys[kind].length || !initial[kind][keys[kind][0]]) throw new Error(`no ${kind} subjects`);
const summary = (values: number[]) => {
  const sorted = [...values].sort((a,b) => a-b);
  const pick = (fraction: number) => Number(sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*fraction)-1)].toFixed(3));
  return { count: values.length, p50: pick(.5), p95: pick(.95), max: pick(1) };
};
const results: Record<string, any> = {};
for (const mode of ["external", "local"] as const) {
  const samples = Object.fromEntries(kinds.map(kind => [kind, { write: [] as number[], refresh: [] as number[], decisions: [] as number[] }]));
  let decisions = 0;
  const original = (reader as any).decideStoredRow;
  (reader as any).decideStoredRow = function(...args: any[]) { decisions++; return original.apply(this,args); };
  const delays: number[] = [];
  let expected = performance.now() + 10;
  const timer = setInterval(() => { const now = performance.now(); delays.push(Math.max(0,now-expected)); expected=now+10; },10);
  try {
    for (let round=0;round<110;round++) {
      for (const kind of kinds) {
        const key = keys[kind][round % keys[kind].length];
        const field = kind === "receipts" ? "clientAttemptId" : "updatedAt";
        const value = kind === "receipts" ? `refresh-${mode}-${round}` : new Date(Date.now()+round).toISOString();
        const start = performance.now();
        (mode === "external" ? writer : reader).mutate((file: any) => {
          file[kind][key][field] = value;
        },false,{ operationName: `mixed-refresh-${kind}` });
        const written = performance.now();
        decisions=0;
        const view = reader.readOnlySnapshot().file;
        const refreshed = performance.now();
        if (round>=10) {
          samples[kind].write.push(written-start);
          samples[kind].refresh.push(refreshed-written);
          samples[kind].decisions.push(decisions);
        }
        // Exercise the collection's deferred materialization before the next write.
        if (view[kind][key]?.[field] !== value) throw new Error(`lost ${kind} write`);
        await Bun.sleep(20);
      }
    }
  } finally { clearInterval(timer); (reader as any).decideStoredRow=original; }
  results[mode]={ kinds: Object.fromEntries(kinds.map(kind => [kind, {
    writeMs: summary(samples[kind].write), refreshMs: summary(samples[kind].refresh),
    grantDecisions: summary(samples[kind].decisions),
  }])), timerLatenessMs: summary(delays) };
}
console.log(JSON.stringify({ rows: dataset.rows, coldRows: dataset.coldRows, runtime: Bun.version, results },null,2));
reader.close();
writer.close();
fs.rmSync(directory,{recursive:true,force:true});
```

For the negative controls, save the following preload outside the checkout.
For each of `all-hot`, `no-dependencies`, `no-identity`, `no-absent`,
`no-receipts` and `no-lineage`, run:

```sh
run_private env REFRESH_CONTROL=<mode> bun test --preload <control.ts> \
  src/lib/agent/sqliteRegistryStore.refresh.test.ts
```

Each control must fail two cases. Run the same file without the preload to
verify all four pass again. The preload changes only the isolated process.

```ts
import path from "node:path";
const { SqliteAgentRegistryStore } = await import(path.join(process.cwd(), "src/lib/agent/sqliteRegistryStore.ts"));
const prototype = SqliteAgentRegistryStore.prototype as any;
const mode = process.env.REFRESH_CONTROL;
if (mode === "all-hot") {
  const refresh = prototype.refreshSnapshot;
  prototype.refreshSnapshot = function(...args: any[]) {
    this.hotGrantsTracked = false;
    return refresh.apply(this, args);
  };
} else {
  const track = prototype.trackHotGrant;
  prototype.trackHotGrant = function(identity: string, dependencies: Set<string>) {
    const retained = new Set([...dependencies].filter(dependency => {
      if (mode === "no-dependencies") return false;
      const [kind, collection, key] = dependency.split("\u0000");
      if (mode === "no-receipts" && kind === "row" && collection === "receipts") return false;
      if (mode === "no-lineage" && (kind === "launch" || (kind === "row" && collection === "lineageEdges"))) return false;
      if (mode === "no-identity") return kind === "row";
      if (mode === "no-absent" && kind === "row") {
        return Boolean(this.db.query(`SELECT 1 FROM ${this.recordsSource} WHERE collection=? AND row_key=?`).get(collection, key));
      }
      return true;
    }));
    return track.call(this, identity, retained);
  };
}
```
