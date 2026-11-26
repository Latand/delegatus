# Gate task limit

Gate checks create a transient service through `scripts/owned-runner.ts`.
`scripts/gate-slot.sh` hands off there with CPU placement on or off, including
the signal-namespace path. Direct test re-entry uses the same launcher.
`scripts/merge-batch.ts` routes its checks, bisects and trusted privacy checks
through its sibling `gate-slot.sh`. The packaged release bundles the same
runner through `scripts/build-gate.ts`.

An inventory with `git grep` found one production launcher for local
`delegatus-gate-<uuid>.service` units, in `owned-runner.ts`. Before this change
it supplied CPU and I/O weights, optional CPU quota, `MemoryMax=14G`, a watchdog
and control-group cleanup. It supplied no `TasksMax`; the measured inherited
`pids.max` was 154146. The remote gate runner's services, the namespace fallback's
existing `pids.max=4096`, deployments and agent scopes have separate policies.

## Measurement before choosing the limit

Measured on Linux on 2026-11-11, base `692e5338ea3f`, Bun 1.4.0, 24 logical
CPUs. Each command ran through the existing installed gate wrapper in a
detached scratch clone, with private HOME, config, temporary and state roots,
a closed Viewer control URL and remote execution disabled. No ref was pushed.

The full pre-push selected the lane's gate infrastructure by adding a blank
line to `scripts/owned-runner.ts` and `scripts/gate-slot.sh` in that clone.
It ran privacy, types, lint, 18 touched test files and the scoped Linux checks;
all passed. The sampler followed only its own command and its gate transports,
read `pids.peak` and `pids.max` every 50 ms while groups existed, and retained
their kernel high-water marks before collection. It discovered 1,105 unit
identities, including nested runner fixtures, and read live peaks for 960;
145 short fixture units disappeared before the first counter read. Both
listed long-running gates were sampled throughout. Values below describe
individual services; siblings have separate counters. Public tables show
unique eight-character unit prefixes; the retained private records keep the
complete unit identities and cgroup paths.

| Run / command | Unit | pids.peak | pids.max | Load at peak; range during run | Result |
| --- | --- | ---: | ---: | --- | --- |
| Full `bun scripts/local-gate.ts pre-push`, largest unit: `local-gate-tests.ts` comparator | `delegatus-gate-9701db2e….service` | 189 | 154146 | 8.62; 5.22–29.72 | pass |
| `bun run test src/components/kanban/kanbanBoard.browser.test.tsx -t 'CPU admission queue'` | `delegatus-gate-e9dc4390….service` | 150 | 154146 | 13.28; 11.93–13.39 | pass |

The browser case exercises English and Ukrainian, light and dark, three
viewport widths and queue/pressure/stalled states. Its first launch failed
because Chromium's socket path was too long; that failed launch is excluded
from sizing. A short temporary-path alias, passed only to Chromium, allowed
the existing driver to complete. No merge-batch run was measured; its local
checks use the same wrapper and service launcher.

## Policy and failure

`scripts/gate-tasks.ts` sets `TasksMax=768`: four times the largest observed legitimate
peak (189), rounded upward to a multiple of 64. The resulting 4.06× margin
allows changes in helper threads and concurrent test activity, while a
recursive fork cannot grow to a thousand tasks in one gate. This is a per-unit
bound; sibling gates retain their own budgets. Existing units are untouched.

The service reads back its own kernel `pids.max` before starting the command.
A present controller that fails to apply the requested limit refuses the
command with `GATE_TASK_LIMIT_UNAVAILABLE`. A refused service start names its
unit with `GATE_UNIT_START_FAILED` and retains the transport's nonzero status.

The service and its outside client sample counters every 50 ms. The outside
client can stop only its freshly generated unit. A positive `pids.events:max`
ends the gate with exit 70 and `GATE_TASK_LIMIT_REACHED`, naming the unit and
limit, including if the command returns success immediately after a denial.
The service saves a final snapshot before exiting; the client retains its own
sample if the supervisor dies. Normal systemd control-group cleanup still
drains descendants before the wrapper returns.

Each service result prints one line containing its unit, `pids.peak`,
`pids.max` and denial count. The touched-test comparator retains these fields
on its existing per-file result line and propagates the owning unit's named
failure before removing its private log. Nested fixture failures cannot
replace the outer unit's reason. Successful grouped hook steps that normally
hide their logs retain the peak on their existing verdict line, including
types and runtime checks. Old kernels without `pids.peak` get an explicitly
labelled sampled lower bound. A missing pids controller or user manager keeps
the existing execution/cleanup path and states the reason once, inherited
through nested gates. A present but unreadable denial counter refuses
execution because a named limit failure could not be established.

The counters and thread accounting follow the
[kernel cgroup v2 PID interface](https://docs.kernel.org/admin-guide/cgroup-v2.html#pid).

## Contained failure control

`scripts/fixtures/gateForkStorm.py` refuses before any fork unless its real
cgroup is an admitted gate service with a finite `pids.max` from 32 to 4096
and a fresh denial counter. Only the original process forks: at most
`pids.max + 1` attempts, within two seconds. Children only sleep, with their
own three-second alarm; the parent has a five-second alarm and reaps its own
recorded children. Neither the count nor the deadline depends on the runner.

`scripts/gate-tasks.integration.test.ts` runs live saturation, immediate
successful exit after denial and a stopped internal supervisor, asserts
peak=max=768 and exit 70 within eight
seconds, and checks that a separate gate keeps ticking. It also checks real
limit readback, refusal before command start when the kernel limit differs,
the fixture's refusal guard and a refused unit launch.

## Verification under the limit

The final gate implementation was exercised against base `a1e86de31884` with
the full pre-push gate family and scoped Linux checks. All 21 touched test
files and 17 scoped Linux files completed with a green head; types, lint and
privacy passed. The same browser case passed again.

| Run / command | Unit | pids.peak | pids.max | Load at peak; range during run | Result |
| --- | --- | ---: | ---: | --- | --- |
| Full `bun scripts/local-gate.ts pre-push`, largest legitimate unit: touched-test comparator | `delegatus-gate-ecd012ad….service` | 189 | 768 | 14.25; 9.22–25.65 | pass |
| Same kanban browser command as above | `delegatus-gate-f08d106a….service` | 151 | 768 | 11.06; 10.82–11.58 | pass |

Intentional saturation controls reached 768 and returned the named failure;
they are excluded from legitimate sizing. Live process arguments identified
those units while the sampler ran. Three saturation variants and the real
comparator propagation case passed, with sibling gates remaining active.

The optional kernel namespace suite is an existing environment limitation:
with `LLV_SIGNAL_SANDBOX_KERNEL_TEST=1`, all five cases fail before reaching
the gate probe because the launcher supplies no namespace context. The same
five failures reproduced on base `a1e86de31884` with the same isolation; the
ordinary invocation skips them. Direct service readback covers CPU placement
both on and off, and the shared launcher applies the same task property
before its namespace handoff.

Before delivery, main advanced to `e048e9744356` (installer and resident-worker
memory changes). Integration preserved the measured gate source byte for byte.
The direct gate-slot file passed all 16 tests again, including its installer
contract, and the complete TypeScript check passed on the integrated tree.
