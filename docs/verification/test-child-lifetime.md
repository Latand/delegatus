# Test child lifetime

## CPU investigation

The real `stageHostGeneration.ts` fixture was run in adopt mode in fresh
temporary home, config, cache, state and temp directories, against an absent
runtime socket and a closed Viewer control port. The parent exited normally.
Identity-bound cleanup found zero owned survivors after each experiment.

| Experiment | CPU seconds in a 2-second sample |
| --- | ---: |
| Startup held at the real refresh barrier | 0.07 |
| Startup settled, original final unresolved promise | 3.06 |
| Same fixture with a referenced idle timer | 0.01 |

Tracing from process birth under Bun 1.4.0 recorded 163,074 `epoll_pwait2`
calls and 218,780 `futex` calls during a bounded run. A separate syscall
trace showed repeated `epoll_pwait2` calls with `{tv_sec=0, tv_nsec=0}`,
each returning zero events. Attaching to an already running process was
refused by the host's ptrace policy. A CPU profile taken with a referenced
exit timer removed the spin itself, so its startup samples were not used to
attribute the idle loop.

The cause is the fixture's unresolved top-level promise after its substituted
startup scheduler has left no referenced event source. Bun keeps polling its
empty event loop. The fixture now holds a real sleep timer. This reproduces
while the parent is alive too; orphaning prolongs it indefinitely. The loop
is in the proof fixture, so no product startup behavior changes in this fix.

The actual-fixture regression was red before the fix: 1,480 CPU milliseconds
in a 1-second idle window, against a 200-millisecond ceiling. The test always
terminates its recorded child and asserts its start identity is gone.
