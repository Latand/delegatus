# Runtime idle performance

The shared phone browser driver renders the real Viewer and production CSS
at 390 × 844 with Chromium CPU throttling ×4. Its isolated RuntimeJournal
holds 120 synthetic sessions with quiet running turns, a snapshot of about
1.3 MB (asserted to be 1.2–1.5 million bytes), and one session's
`limits` event every second. The browser uses the production runtime bus,
snapshot parsing and SSE transport. Other API responses use the driver's
existing fixtures.

`before.json` measures product code at the pinned base `30f500351` with the
new driver case. `after.json` repeats that case with the fix. Both count
snapshot requests during a 60-second idle window, excluding the initial join,
and measure requestAnimationFrame throughput. Cold-load time to interactive
uses the audit's definition: the end of the last long task before two seconds
without a long task. A null value means no quiet window within 30 seconds of
the first card becoming visible.

These are controlled headless measurements. The original production audit
used a larger live catalog and active streams: 63 idle snapshot fetches/minute
(21 in 20 seconds), phone idle 43 fps, and phone cold-load TTI 9.4 seconds.
The controlled run measures this change's effect; it does not measure a
deployment or a physical phone.

Run from the repository root with an installed Chromium binary:

```sh
TMPDIR=/var/tmp LLV_STATE_DIR="$(mktemp -d)" \
LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN="<chromium-binary>" \
flock /var/tmp/llv-heavy-gate.lock \
bun test src/components/mobile/issue1671Evidence.browser.test.tsx \
  -t 'limits keep the phone stream joined'
```

Set `LLV_RUNTIME_PERF_LABEL=before` only when running the unchanged product
code. The baseline must fail the zero-refetch assertion; the fixed code must
pass it. The browser case writes only aggregate performance readings here.

## Recorded comparison

| Metric | Pinned base | Fixed code |
| --- | ---: | ---: |
| Snapshot payload | 1,297,927 bytes | 1,297,927 bytes |
| Idle snapshot refetches / minute | 60 | 0 |
| Idle requestAnimationFrame fps, CPU ×4 | 60 | 60 |
| Phone cold-load time to interactive | 813 ms | 806 ms |

The controlled fixture eliminates roughly 77.9 MB of redundant snapshot JSON
per idle minute. Its frame rate and cold-load time were already healthy;
the 7 ms TTI difference does not establish an improvement. The production
audit's 43 fps and 9.4 s TTI require a post-deployment measurement of the live
catalog to assess improvement there.

The journal/bus regression fails on the base with 21 snapshot fetches for
20 injected limits events; the fixed implementation requires only the initial
fetch. Skipping a real revision still causes one recovery fetch and forwards
the recovered files revision, covering the #2407 notification contract.
Persistence/redelivery and unknown session-event tests also fail on the base.
Formatter regressions observe 20 plural/time allocations and 100 report-time
allocations on the base, bounded to 2, 2 and 6 respectively with the caches;
English and Ukrainian output stays the same.
