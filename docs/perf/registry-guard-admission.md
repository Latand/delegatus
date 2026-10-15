# Registry admission and unchanged credit-guard ticks

The guard watchdog now checks in-memory registry and obligation revisions before accessing storage. A changed input starts a page of at most 64 pending obligations. The cursor completes an outstanding scan across ticks; a 30-second fallback discovers cross-process changes. Failed passes remain dirty. Explicit delivery events retain immediate reconciliation. Obligation transactions carry the `account-credit-guard.obligations` origin and log synchronous or asynchronous admission waits of at least 50 ms.

Registry admission currently covers the pipeline parent, retry-claim and reseat paths, plus guard recovery writes. Keyed reads made before the admitted mutation share its transaction. The remaining production caller migration for requirement A includes runtime-switch cancellation and termination persistence. Those engine paths require an extension of the shared-file scope before A can be completed.

The comparison below exercises the synchronous mutation and asynchronous admission primitive in an isolated Bun main thread, together with the actual guard function. Each fresh state contains 128 unresolved guard obligations whose conversations are absent. Both variants make three warm-up guard calls, four registry mutations while a peer holds the writer for 200 ms each, and four unchanged guard ticks separated by one second. The measured intervals last about 4.8 seconds. Linux thread CPU has a 10 ms clock resolution. The baseline is `5352d66c340705d47390b58aa142fd848f056848`; the candidate source fingerprint and raw samples are in [the evidence record](../../evidence/perf/registry-guard-admission.json).

Each cell shows baseline → candidate. Runs alternate baseline, candidate, three times.

| Pair | Main CPU ms | Core % | Max timer delay ms | Max synchronous mutation ms | Guard file reads | Synchronous waits | Async waits |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 70 → 50 | 1.45 → 1.04 | 197.53 → 1.63 | 202.40 → 1.60 | 272 → 0 | 4 → 0 | 0 → 4 |
| 2 | 100 → 70 | 2.06 → 1.45 | 199.69 → 2.63 | 203.48 → 1.65 | 272 → 0 | 4 → 0 | 0 → 4 |
| 3 | 90 → 70 | 1.86 → 1.45 | 199.35 → 2.81 | 202.83 → 2.05 | 272 → 0 | 4 → 0 | 0 → 4 |

The peer-held waits still total about 0.8 seconds per run. Asynchronous admission leaves the main loop available during those waits. The four unchanged candidate ticks make zero obligation-file reads. These samples measure the admission primitive and guard change; completion of the remaining caller migration is still pending.

To reproduce one sample from a source export with its dependencies installed, copy the same measurement driver into both source exports and use a new empty sandbox for each invocation. Set `MEASURE_ASYNC=0` for the baseline and `MEASURE_ASYNC=1` for the candidate. Run six invocations in the order above. Keep the Bun interpreter, fixture and gate wrapper the same.

```sh
sample_root=$(mktemp -d "${TMPDIR:?}/registry-guard.XXXXXX")
mkdir -p "$sample_root/home" "$sample_root/config" "$sample_root/tmp" "$sample_root/state"
env -u LLV_STATE_OWNER HOME="$sample_root/home" XDG_CONFIG_HOME="$sample_root/config" \
  TMPDIR="$sample_root/tmp" LLV_STATE_DIR="$sample_root/state" NODE_ENV=test \
  LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1 MEASURE_ASYNC=1 \
  bash scripts/gate-slot.sh bun scripts/measure-registry-guard.ts
```

Validation ran each test file in a separate process with fresh HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, and a closed Viewer control URL. There are 713 passing tests across the guard tick, existing guard behavior, registry writer, file-transaction wait, interruption-obligation, registry reader, and pipeline ports/recovery/publication files. The new cases cover idle watchdog calls, pending changes, failure retry, cross-process fallback, process restart, admitted reads, replay, rollback and file-lock diagnostics. TypeScript and changed-file ESLint passed; ESLint retained nine existing warnings. The local privacy gate passed on the source and test paths. No runtime-host source changed.
