# Viewer stalls after PR 3846

Observation date: 2026-11-11, UTC. Measured release: `692e5338`.
The measured window is **70 minutes (69 minutes 56.816 seconds)**. The
specification's 90-minute criterion was **not met** on this release and
cannot be completed: an operator deployment replaced it with `662a6012`.
The coordinator accepted this interrupted window as the diagnostic basis
on 2026-11-11 at 12:56:54 UTC. A separate 90-minute measurement on the
installed release remains required before the next deployment.

This document supplies parts 1 to 4 of the follow-up specification. The next
stage supplies the ordered implementation plan.

The originating board requirements are “Delegatus став частіше підвисати з
28.10” and “Runtime host гальмує на перебудові знімка сесій”. Both full task
records were read on 2026-11-11. The first task records the increase observed
on 28 October; the second records the snapshot diagnosis relayed on 9 November.
Private conversation quotations and identities are excluded.

## 1. Measurement after startup

The release apply completed at 11:17:27.253. The observation begins at
11:27:27, following the specification's ten-minute exclusion. The Viewer and
runtime host have separate measurements. The earlier reference window ends
at 09:27:27, before the later operator-applied builds; its duration matches
the new window. Neither window is a controlled replay.
The serving identities stayed fixed within the cohort while load varied.
Ten-minute slices describe that variation. An external operator deployment
switched the release pointer to `662a6012` at 12:37:23.816; its new Viewer
started at 12:37:44.306. The measurement ends at the switch. Old-release
records received after that boundary are excluded. The requested 90-minute
cohort on `692e5338` never existed after the ten-minute exclusion: the
maximum pre-switch interval is 69 minutes 56.816 seconds. This duration
criterion remains unmet. The accepted decision retains this interrupted
cohort as diagnosis and proceeds to the ordered plan. The old cohort,
including its commands, load observations, checksums and sensitivity
measurement, is preserved without collecting it again.

<!-- measurement:start -->
Window: **2026-11-11T11:27:27.000Z to 2026-11-11T12:37:23.816Z**, 69.95 minutes. Earlier equal-duration reference: **2026-11-11T08:17:30.184Z to 2026-11-11T09:27:27.000Z**.

**Collection ended at an external release switch before the required 90 minutes. This 69.9469-minute cohort cannot satisfy that duration criterion.**

| Process | Metric | Earlier 803f12c1 | Steady 692e5338 |
| --- | --- | --- | --- |
| viewer | gaps | 775  | 801  |
| viewer | gap time | 1,111,531 ms | 1,095,605 ms |
| viewer | gap share | 26.4851 % | 26.1056 % |
| viewer | p50 | 849 ms | 817 ms |
| viewer | p95 | 2,632 ms | 3,637 ms |
| viewer | maximum | 63,660 ms | 16,078 ms |
| runtime-host | gaps | 12  | 37  |
| runtime-host | gap time | 3,774 ms | 12,041 ms |
| runtime-host | gap share | 0.0899 % | 0.2869 % |
| runtime-host | p50 | 307.5 ms | 296 ms |
| runtime-host | p95 | 386 ms | 476 ms |
| runtime-host | maximum | 396 ms | 625 ms |

Serving PIDs in the cohort: Viewer [3875509], runtime host [3874112]; earlier [3248041] and [3247442]. The Viewer sequence spans [119, 919], with 0 missing sequence numbers; logDropped values [0]. The earlier cohort has 5 records with scalar-only recovery; the steady cohort has 2.

Ten-minute slices, with a shorter final slice retained:

| Start UTC | End UTC | Viewer gaps | Gap seconds | Wall-time share |
| --- | --- | --- | --- | --- |
| 11:27:27.000 | 11:37:27.000 | 153 | 207.865 | 34.6442% |
| 11:37:27.000 | 11:47:27.000 | 99 | 160.726 | 26.7877% |
| 11:47:27.000 | 11:57:27.000 | 109 | 133.446 | 22.2410% |
| 11:57:27.000 | 12:07:27.000 | 101 | 135.188 | 22.5313% |
| 12:07:27.000 | 12:17:27.000 | 65 | 62.289 | 10.3815% |
| 12:17:27.000 | 12:27:27.000 | 109 | 127.916 | 21.3193% |
| 12:27:27.000 | 12:37:23.816 | 165 | 268.175 | 44.9343% |

<!-- measurement:end -->

The measure follows [the earlier design, section 11](viewer-stalls-root-cause.md#11-check-after-deploy):
`100 * sum(gapMs) / windowMs`, filtered by the record's internal UTC, role,
PID and release. The monitor reports the excess above its ten-millisecond
timer interval. This is a measure of recorded delay; it includes no claim
about application throughput.

Journal reads use fifteen-minute chunks, each capped at 20,000 rows and an
18-second command timeout, with margins for delayed journal delivery. A cap
hit aborts the measurement. Duplicate deliveries are collapsed by
`(role, pid, sequence, utc)`. A truncated JSON record contributes only its
recoverable scalar gap; its nested attribution is unknown. Section 2 records
that uncertainty. Commands and execution bounds are retained below.

<!-- load:start -->
Persisted session observations are sparse. The earlier receipt reports 106 sessions collected at 08:12:25.286 (receipt 08:20:47.437; acceptance E07). The new-release audit reports 127 early, 129 at 11:34:39 and 134 collected at 11:42:51.898 (acceptance E11/E22). Direct stored reads found 134 collected at 11:53:31.671, 138 collected at 12:13:44.526, and 144 collected at 12:24:15.048. The last receipt still held 144 at the 12:40:48 read. These are observations of the resource collector's session unit; they do not bound the entire interval. A separate process-name count at 12:14:02 found 131 codex and nine claude processes, a different unit.

Running lanes reconstructed at one-minute boundaries from stored attempts:

| Cohort | Start UTC | End UTC | Samples | All projects: range / median | This project: range / median |
| --- | --- | --- | --- | --- | --- |
| before | 2026-11-11T08:17:30.184Z | 2026-11-11T09:27:27.000Z | 70 | 3–13 / 7 | 0–2 / 1 |
| steady | 2026-11-11T11:27:27.000Z | 2026-11-11T12:37:23.816Z | 70 | 8–13 / 10 | 5–9 / 7 |

The reconstruction counts distinct pipelines with a retained attempt covering the sampled instant. Its query read 14,473 rows and excluded 803 records with no end that were no longer current running attempts, plus five projection mismatches. Missing or inconsistent historical rows can undercount concurrency. This is a reconstructed series with those exclusions, separate from the earlier acceptance's live snapshots. The current project is resolved by a bound pipeline-key lookup. No project identity is published.

Runtime events: **20,190 records over 4196.816 seconds, 4.8108 events/s**, from 2026-11-11T11:27:27.000Z to 2026-11-11T12:37:23.816Z. Two captures preserve adjacent sequence intervals [14388967,14402070) and [14402070,14409157). Both reads had full interval coverage, no adjacent timestamp reversal, query_only=1 and zero changes. This counts persisted event envelopes, including item and delta updates; it counts neither bytes nor user requests. Earlier-window events had already expired from the bounded journal, so an earlier event rate is unavailable.

| Start UTC | End UTC | Events | Events/s |
| --- | --- | --- | --- |
| 11:27:27.000 | 11:37:27.000 | 2860 | 4.7667 |
| 11:37:27.000 | 11:47:27.000 | 2592 | 4.3200 |
| 11:47:27.000 | 11:57:27.000 | 2399 | 3.9983 |
| 11:57:27.000 | 12:07:27.000 | 2898 | 4.8300 |
| 12:07:27.000 | 12:17:27.000 | 3662 | 6.1033 |
| 12:17:27.000 | 12:27:27.000 | 3175 | 5.2917 |
| 12:27:27.000 | 12:37:23.816 | 2604 | 4.3632 |

Independent main-thread scheduler counters:

| Sample | Start UTC | End UTC | Wall seconds | CPU seconds | Queued seconds | Main-thread use |
| --- | --- | --- | --- | --- | --- | --- |
| First short sample | 2026-11-11T12:06:30.140970+00:00 | 2026-11-11T12:07:30.144193+00:00 | 60.003221 | 47.651964 | 0.069774 | 79.4157% |
| Second short sample | 2026-11-11T12:19:06.302637+00:00 | 2026-11-11T12:20:06.305924+00:00 | 60.003285 | 52.542721 | 0.036670 | 87.5664% |
| Retained passive endpoints | 2026-11-11T12:25:41.943806+00:00 | 2026-11-11T12:36:41.964002+00:00 | 660.020196 | 631.832038 | 7.302063 | 95.7292% |

All endpoints have Viewer PID 3875509 and start identity 55984392. The second short sample also read 144,473,759 rchar bytes/s and 33,073.689 read calls/s from that thread's /proc counters. These counters include cache-served reads and other descriptors; they cannot name a database or establish disk latency. The passive collector read every 30 seconds and printed alternate samples; twelve printed points survive from 12:25:41.944 to 12:36:41.964. It ended with ENOENT after the old process disappeared, before its planned 13:00 end, and produced no final full sample array. Only printed points are retained here. Their one-minute load average ranges from 9.00 to 32.46. None of these samples provides utilization for the full cohort or attributes the CPU to a function.

The operator apply began at 12:31:11.902, so the final six minutes also include deployment preparation on this machine. A sensitivity cohort ending at that start, 11:27:27–12:31:11.902 (63 minutes 44.902 seconds), contains 695 Viewer records and 963.758 seconds of gaps: **25.1969%** of wall time. Its residual is 706.459 seconds, **73.3025%** of gap time; the runtime host is at 0.3073%. Removing deployment preparation therefore retains the stall and attribution failures. This shorter cohort also fails the requested duration.

The equal-duration reference and this cohort differ in session count, project concurrency, event coverage and deployment activity. The 63.660-second maximum in the reference lies outside the acceptance's shorter 08:00–08:30 window. Its larger value here follows the changed time bounds. Both Viewer gap shares remain far above section 11's under-5% threshold. These unmatched observations establish persistence of stalls and do not estimate a repair's gain or loss.

### Required follow-up: a separate 90-minute window

This is an acceptance obligation, with no result recorded here. Pin the
release actually serving when collection begins (`662a6012` or later),
both process identities and their restart times. Start at least ten
minutes after that release's restart, using the later serving-process
restart if the Viewer and runtime host started separately. For the
retained `662a6012` startup records, the earliest start is
**12:47:44.306 UTC** and the earliest 90-minute end is **14:17:44.306 UTC**
on 2026-11-11. A later restart moves both bounds. These are calculated
bounds, derived from the Viewer start at 12:37:44.306 in the provenance
record below.

Use the same bounded journal collector, internal timestamps, release and
PID filters, deduplication, gap-share formula and attribution rules as
sections 1 and 2. Retain ten-minute slices, sequence coverage, truncated
records, execution bounds and checksums. Record session observations with
their collection times, running lanes across all projects and this
project, event rate and retention coverage, load average, and main-thread
scheduler counters. Preserve event intervals while they still exist.
Record the history-drain switch and its stored progress without changing
either; installation alone does not establish that history has moved.

A release switch ends that cohort. Report its actual length and start a
separate cohort after the successor's startup exclusion. Keep the
`692e5338` figures and any successor figures in separate tables with
separate denominators. The follow-up must happen before deploying the
observation wrapper proposed in section 4. Offline implementation and
rehearsal can proceed while this obligation remains open. Acceptance
still uses section 11's under-5% Viewer gap share at comparable load;
an unmatched result establishes only the stalls present in that window.

<details>
<summary>Retained load rows, execution bounds and exact commands</summary>

```json
{
  "eventsPart1": {
    "readStart": "2026-11-11T12:15:30.438630+00:00",
    "first": [
      14382522,
      1794395134644
    ],
    "last": [
      14402522,
      1794399330420
    ],
    "lo": 1794396447000,
    "hi": 1794399240000,
    "seqStart": 14388967,
    "seqEnd": 14402070,
    "complete": true,
    "rows": 13103,
    "kinds": {
      "delta": 2132,
      "item": 8606,
      "limits": 1115,
      "pipeline.provider-continuation-cancelled": 358,
      "session-status": 187,
      "turn-ended": 42,
      "files.revision": 171,
      "receipt": 430,
      "turn-started": 45,
      "edge.created": 17
    },
    "perMinute": {
      "29906607": 148,
      "29906608": 277,
      "29906609": 315,
      "29906610": 200,
      "29906611": 235,
      "29906612": 267,
      "29906613": 339,
      "29906614": 261,
      "29906615": 402,
      "29906616": 308,
      "29906617": 220,
      "29906618": 222,
      "29906619": 225,
      "29906620": 186,
      "29906621": 245,
      "29906622": 296,
      "29906623": 490,
      "29906624": 222,
      "29906625": 228,
      "29906626": 268,
      "29906627": 198,
      "29906628": 208,
      "29906629": 198,
      "29906630": 328,
      "29906631": 231,
      "29906632": 286,
      "29906633": 170,
      "29906634": 288,
      "29906635": 191,
      "29906636": 220,
      "29906637": 401,
      "29906638": 272,
      "29906639": 191,
      "29906640": 256,
      "29906641": 387,
      "29906642": 327,
      "29906643": 253,
      "29906644": 254,
      "29906645": 292,
      "29906646": 297,
      "29906647": 458,
      "29906648": 481,
      "29906649": 376,
      "29906650": 327,
      "29906651": 216,
      "29906652": 324,
      "29906653": 319
    },
    "changes": 0,
    "query_only": 1,
    "perBin": {
      "0": 2860,
      "1": 2592,
      "2": 2399,
      "3": 2898,
      "4": 2354
    },
    "rowsSHA256": "49f59ad26086c0f121762e416300da876511e8868a4700e6230787a5039deb7f",
    "nonmonotonicPairs": 0,
    "rowTimeBounds": [
      1794396447013,
      1794399239049
    ],
    "readEnd": "2026-11-11T12:15:30.470212+00:00"
  },
  "eventsPart2": {
    "readStart": "2026-11-11T12:40:48.103370+00:00",
    "first": [
      14389676,
      1794396590295
    ],
    "last": [
      14409675,
      1794400848055
    ],
    "lo": 1794399240000,
    "hi": 1794400643816,
    "seqStart": 14402070,
    "seqEnd": 14409157,
    "complete": true,
    "rows": 7087,
    "kinds": {
      "item": 4758,
      "receipt": 181,
      "limits": 714,
      "pipeline.provider-continuation-cancelled": 162,
      "delta": 1070,
      "session-status": 67,
      "edge.created": 9,
      "files.revision": 81,
      "turn-started": 22,
      "turn-ended": 23
    },
    "perMinute": {
      "29906654": 257,
      "29906655": 434,
      "29906656": 439,
      "29906657": 352,
      "29906658": 315,
      "29906659": 362,
      "29906660": 362,
      "29906661": 371,
      "29906662": 381,
      "29906663": 324,
      "29906664": 279,
      "29906665": 292,
      "29906666": 272,
      "29906667": 133,
      "29906668": 184,
      "29906669": 300,
      "29906670": 187,
      "29906671": 275,
      "29906672": 253,
      "29906673": 285,
      "29906674": 361,
      "29906675": 263,
      "29906676": 277,
      "29906677": 129
    },
    "changes": 0,
    "query_only": 1,
    "perBin": {
      "4": 1308,
      "5": 3175,
      "6": 2604
    },
    "rowsSHA256": "2591b1ad52dde578443b0bc4a81a6ed12df53901ec7dba17783904bb173c152e",
    "nonmonotonicPairs": 0,
    "rowTimeBounds": [
      1794399240215,
      1794400639022
    ],
    "readEnd": "2026-11-11T12:40:48.118371+00:00"
  },
  "load": {
    "readStart": "2026-11-11T12:40:48.104046+00:00",
    "windows": {
      "before": {
        "lo": 1794385050184,
        "hi": 1794389247000,
        "minuteSamples": [
          [
            1794385050184,
            5,
            1
          ],
          [
            1794385110184,
            5,
            1
          ],
          [
            1794385170184,
            5,
            1
          ],
          [
            1794385230184,
            5,
            1
          ],
          [
            1794385290184,
            6,
            1
          ],
          [
            1794385350184,
            7,
            1
          ],
          [
            1794385410184,
            9,
            1
          ],
          [
            1794385470184,
            10,
            1
          ],
          [
            1794385530184,
            11,
            1
          ],
          [
            1794385590184,
            12,
            1
          ],
          [
            1794385650184,
            12,
            1
          ],
          [
            1794385710184,
            12,
            1
          ],
          [
            1794385770184,
            13,
            2
          ],
          [
            1794385830184,
            12,
            2
          ],
          [
            1794385890184,
            12,
            2
          ],
          [
            1794385950184,
            12,
            2
          ],
          [
            1794386010184,
            13,
            2
          ],
          [
            1794386070184,
            12,
            2
          ],
          [
            1794386130184,
            11,
            2
          ],
          [
            1794386190184,
            10,
            2
          ],
          [
            1794386250184,
            10,
            2
          ],
          [
            1794386310184,
            8,
            2
          ],
          [
            1794386370184,
            9,
            2
          ],
          [
            1794386430184,
            9,
            2
          ],
          [
            1794386490184,
            9,
            2
          ],
          [
            1794386550184,
            8,
            1
          ],
          [
            1794386610184,
            7,
            1
          ],
          [
            1794386670184,
            8,
            1
          ],
          [
            1794386730184,
            8,
            1
          ],
          [
            1794386790184,
            8,
            1
          ],
          [
            1794386850184,
            8,
            1
          ],
          [
            1794386910184,
            8,
            1
          ],
          [
            1794386970184,
            5,
            1
          ],
          [
            1794387030184,
            6,
            1
          ],
          [
            1794387090184,
            7,
            1
          ],
          [
            1794387150184,
            7,
            1
          ],
          [
            1794387210184,
            8,
            1
          ],
          [
            1794387270184,
            9,
            2
          ],
          [
            1794387330184,
            8,
            2
          ],
          [
            1794387390184,
            7,
            2
          ],
          [
            1794387450184,
            7,
            2
          ],
          [
            1794387510184,
            7,
            2
          ],
          [
            1794387570184,
            7,
            2
          ],
          [
            1794387630184,
            6,
            2
          ],
          [
            1794387690184,
            5,
            2
          ],
          [
            1794387750184,
            6,
            2
          ],
          [
            1794387810184,
            5,
            2
          ],
          [
            1794387870184,
            6,
            2
          ],
          [
            1794387930184,
            6,
            2
          ],
          [
            1794387990184,
            6,
            2
          ],
          [
            1794388050184,
            4,
            1
          ],
          [
            1794388110184,
            4,
            1
          ],
          [
            1794388170184,
            4,
            1
          ],
          [
            1794388230184,
            5,
            1
          ],
          [
            1794388290184,
            6,
            2
          ],
          [
            1794388350184,
            5,
            1
          ],
          [
            1794388410184,
            6,
            1
          ],
          [
            1794388470184,
            4,
            1
          ],
          [
            1794388530184,
            4,
            1
          ],
          [
            1794388590184,
            4,
            1
          ],
          [
            1794388650184,
            4,
            1
          ],
          [
            1794388710184,
            3,
            1
          ],
          [
            1794388770184,
            3,
            1
          ],
          [
            1794388830184,
            3,
            1
          ],
          [
            1794388890184,
            4,
            1
          ],
          [
            1794388950184,
            4,
            1
          ],
          [
            1794389010184,
            3,
            0
          ],
          [
            1794389070184,
            3,
            0
          ],
          [
            1794389130184,
            3,
            0
          ],
          [
            1794389190184,
            3,
            0
          ]
        ]
      },
      "steady": {
        "lo": 1794396447000,
        "hi": 1794400643816,
        "minuteSamples": [
          [
            1794396447000,
            10,
            6
          ],
          [
            1794396507000,
            8,
            6
          ],
          [
            1794396567000,
            8,
            6
          ],
          [
            1794396627000,
            9,
            6
          ],
          [
            1794396687000,
            10,
            6
          ],
          [
            1794396747000,
            10,
            6
          ],
          [
            1794396807000,
            11,
            6
          ],
          [
            1794396867000,
            13,
            7
          ],
          [
            1794396927000,
            13,
            7
          ],
          [
            1794396987000,
            13,
            7
          ],
          [
            1794397047000,
            13,
            7
          ],
          [
            1794397107000,
            13,
            7
          ],
          [
            1794397167000,
            11,
            7
          ],
          [
            1794397227000,
            11,
            7
          ],
          [
            1794397287000,
            11,
            7
          ],
          [
            1794397347000,
            12,
            7
          ],
          [
            1794397407000,
            11,
            7
          ],
          [
            1794397467000,
            10,
            7
          ],
          [
            1794397527000,
            10,
            7
          ],
          [
            1794397587000,
            11,
            7
          ],
          [
            1794397647000,
            11,
            7
          ],
          [
            1794397707000,
            10,
            7
          ],
          [
            1794397767000,
            9,
            7
          ],
          [
            1794397827000,
            10,
            7
          ],
          [
            1794397887000,
            9,
            6
          ],
          [
            1794397947000,
            9,
            6
          ],
          [
            1794398007000,
            9,
            6
          ],
          [
            1794398067000,
            10,
            7
          ],
          [
            1794398127000,
            9,
            6
          ],
          [
            1794398187000,
            9,
            6
          ],
          [
            1794398247000,
            9,
            6
          ],
          [
            1794398307000,
            9,
            6
          ],
          [
            1794398367000,
            8,
            5
          ],
          [
            1794398427000,
            9,
            6
          ],
          [
            1794398487000,
            10,
            7
          ],
          [
            1794398547000,
            10,
            7
          ],
          [
            1794398607000,
            10,
            7
          ],
          [
            1794398667000,
            11,
            8
          ],
          [
            1794398727000,
            11,
            8
          ],
          [
            1794398787000,
            10,
            8
          ],
          [
            1794398847000,
            10,
            8
          ],
          [
            1794398907000,
            10,
            8
          ],
          [
            1794398967000,
            9,
            7
          ],
          [
            1794399027000,
            9,
            7
          ],
          [
            1794399087000,
            9,
            7
          ],
          [
            1794399147000,
            9,
            7
          ],
          [
            1794399207000,
            8,
            6
          ],
          [
            1794399267000,
            9,
            7
          ],
          [
            1794399327000,
            9,
            7
          ],
          [
            1794399387000,
            9,
            7
          ],
          [
            1794399447000,
            9,
            7
          ],
          [
            1794399507000,
            10,
            8
          ],
          [
            1794399567000,
            10,
            8
          ],
          [
            1794399627000,
            11,
            8
          ],
          [
            1794399687000,
            10,
            8
          ],
          [
            1794399747000,
            10,
            8
          ],
          [
            1794399807000,
            10,
            8
          ],
          [
            1794399867000,
            10,
            8
          ],
          [
            1794399927000,
            10,
            8
          ],
          [
            1794399987000,
            10,
            8
          ],
          [
            1794400047000,
            10,
            8
          ],
          [
            1794400107000,
            10,
            8
          ],
          [
            1794400167000,
            10,
            8
          ],
          [
            1794400227000,
            10,
            8
          ],
          [
            1794400287000,
            10,
            8
          ],
          [
            1794400347000,
            10,
            8
          ],
          [
            1794400407000,
            10,
            8
          ],
          [
            1794400467000,
            10,
            8
          ],
          [
            1794400527000,
            10,
            8
          ],
          [
            1794400587000,
            11,
            9
          ]
        ]
      }
    },
    "rows": 14473,
    "excluded": {
      "missing end, not current running": 803,
      "projection mismatch": 5
    },
    "changes": 0,
    "query_only": 1,
    "resource": {
      "completedAt": 1794399855048,
      "count": 144,
      "withRSS": 144,
      "hostCount": 144,
      "status": "complete"
    },
    "loadavg": [
      "11.98",
      "14.21",
      "14.22"
    ],
    "readEnd": "2026-11-11T12:40:48.299215+00:00"
  },
  "schedulerInitial": {
    "wallSeconds": 60.00322143104859,
    "runSeconds": 47.651964024,
    "queueSeconds": 0.069774366,
    "utilisationPercent": 79.41567617125062,
    "samples": [
      {
        "utc": "2026-11-11T12:06:30.140970+00:00",
        "mono": 562843.215870203,
        "identity": "55984392",
        "runNs": 2826409044494,
        "queueNs": 13577995549,
        "slices": 2115183
      },
      {
        "utc": "2026-11-11T12:06:35.141240+00:00",
        "mono": 562848.216138875,
        "identity": "55984392",
        "runNs": 2827450210792,
        "queueNs": 13599406720,
        "slices": 2116418
      },
      {
        "utc": "2026-11-11T12:06:40.141564+00:00",
        "mono": 562853.21647193,
        "identity": "55984392",
        "runNs": 2830444355542,
        "queueNs": 13601775732,
        "slices": 2117533
      },
      {
        "utc": "2026-11-11T12:06:45.141809+00:00",
        "mono": 562858.216711742,
        "identity": "55984392",
        "runNs": 2834001957001,
        "queueNs": 13604600930,
        "slices": 2118984
      },
      {
        "utc": "2026-11-11T12:06:50.142063+00:00",
        "mono": 562863.216961885,
        "identity": "55984392",
        "runNs": 2836893301520,
        "queueNs": 13607159294,
        "slices": 2120232
      },
      {
        "utc": "2026-11-11T12:06:55.142263+00:00",
        "mono": 562868.217160899,
        "identity": "55984392",
        "runNs": 2840166693569,
        "queueNs": 13608620721,
        "slices": 2121294
      },
      {
        "utc": "2026-11-11T12:07:00.142557+00:00",
        "mono": 562873.217460294,
        "identity": "55984392",
        "runNs": 2845088250947,
        "queueNs": 13614733486,
        "slices": 2121812
      },
      {
        "utc": "2026-11-11T12:07:05.142890+00:00",
        "mono": 562878.217800658,
        "identity": "55984392",
        "runNs": 2849983221087,
        "queueNs": 13628199389,
        "slices": 2122285
      },
      {
        "utc": "2026-11-11T12:07:10.143231+00:00",
        "mono": 562883.218134784,
        "identity": "55984392",
        "runNs": 2854537533609,
        "queueNs": 13639102610,
        "slices": 2123054
      },
      {
        "utc": "2026-11-11T12:07:15.143488+00:00",
        "mono": 562888.218389697,
        "identity": "55984392",
        "runNs": 2859508538274,
        "queueNs": 13639700207,
        "slices": 2123433
      },
      {
        "utc": "2026-11-11T12:07:20.143718+00:00",
        "mono": 562893.218619127,
        "identity": "55984392",
        "runNs": 2864401426773,
        "queueNs": 13642385054,
        "slices": 2124127
      },
      {
        "utc": "2026-11-11T12:07:25.143967+00:00",
        "mono": 562898.218870575,
        "identity": "55984392",
        "runNs": 2869229064247,
        "queueNs": 13643966898,
        "slices": 2145165
      },
      {
        "utc": "2026-11-11T12:07:30.144193+00:00",
        "mono": 562903.219091634,
        "identity": "55984392",
        "runNs": 2874061008518,
        "queueNs": 13647769915,
        "slices": 2164872
      }
    ]
  },
  "schedulerSecond": {
    "wallSeconds": 60.00328464107588,
    "runSeconds": 52.54272133,
    "queueSeconds": 0.036669891,
    "utilisationPercent": 87.56640847963068,
    "rcharPerSecond": 144473759.02594528,
    "readCallsPerSecond": 33073.6894133537,
    "samples": [
      {
        "utc": "2026-11-11T12:19:06.302637+00:00",
        "mono": 563599.37753777,
        "identity": "55984392",
        "runNs": 3417619892082,
        "queueNs": 14399915005,
        "rchar": 545291223899,
        "syscr": 121139596
      },
      {
        "utc": "2026-11-11T12:19:11.303170+00:00",
        "mono": 563604.378071743,
        "identity": "55984392",
        "runNs": 3422009818544,
        "queueNs": 14402392289,
        "rchar": 546100241426,
        "syscr": 121334719
      },
      {
        "utc": "2026-11-11T12:19:16.303411+00:00",
        "mono": 563609.378309688,
        "identity": "55984392",
        "runNs": 3426836068646,
        "queueNs": 14404772813,
        "rchar": 547050015905,
        "syscr": 121566358
      },
      {
        "utc": "2026-11-11T12:19:21.303627+00:00",
        "mono": 563614.378525403,
        "identity": "55984392",
        "runNs": 3431014530579,
        "queueNs": 14414344609,
        "rchar": 549392891105,
        "syscr": 122135890
      },
      {
        "utc": "2026-11-11T12:19:26.303846+00:00",
        "mono": 563619.378744542,
        "identity": "55984392",
        "runNs": 3435770317328,
        "queueNs": 14415030057,
        "rchar": 549666219026,
        "syscr": 122201032
      },
      {
        "utc": "2026-11-11T12:19:31.304083+00:00",
        "mono": 563624.378981441,
        "identity": "55984392",
        "runNs": 3440592367051,
        "queueNs": 14418015725,
        "rchar": 550097834760,
        "syscr": 122308867
      },
      {
        "utc": "2026-11-11T12:19:36.304285+00:00",
        "mono": 563629.379183059,
        "identity": "55984392",
        "runNs": 3444738101704,
        "queueNs": 14422668705,
        "rchar": 550368221229,
        "syscr": 122373642
      },
      {
        "utc": "2026-11-11T12:19:41.304512+00:00",
        "mono": 563634.379409289,
        "identity": "55984392",
        "runNs": 3448061552365,
        "queueNs": 14425929500,
        "rchar": 550949657361,
        "syscr": 122511493
      },
      {
        "utc": "2026-11-11T12:19:46.304780+00:00",
        "mono": 563639.379680969,
        "identity": "55984392",
        "runNs": 3452531724209,
        "queueNs": 14427912498,
        "rchar": 551710856438,
        "syscr": 122689123
      },
      {
        "utc": "2026-11-11T12:19:51.305100+00:00",
        "mono": 563644.380014303,
        "identity": "55984392",
        "runNs": 3456556438223,
        "queueNs": 14429817629,
        "rchar": 552314565927,
        "syscr": 122829616
      },
      {
        "utc": "2026-11-11T12:19:56.305350+00:00",
        "mono": 563649.380249925,
        "identity": "55984392",
        "runNs": 3460481012192,
        "queueNs": 14433886269,
        "rchar": 552746642887,
        "syscr": 122932590
      },
      {
        "utc": "2026-11-11T12:20:01.305656+00:00",
        "mono": 563654.38056004,
        "identity": "55984392",
        "runNs": 3465201024462,
        "queueNs": 14435911551,
        "rchar": 553372368513,
        "syscr": 123028104
      },
      {
        "utc": "2026-11-11T12:20:06.305924+00:00",
        "mono": 563659.380822411,
        "identity": "55984392",
        "runNs": 3470162613412,
        "queueNs": 14436584896,
        "rchar": 553960123985,
        "syscr": 123124126
      }
    ]
  },
  "passiveSamples": [
    {
      "utc": "2026-11-11T12:25:41.943806+00:00",
      "mono": 563995.018709736,
      "identity": "55984392",
      "runNs": 3738725167374,
      "queueNs": 14765333831,
      "rchar": 602413277763,
      "syscr": 134201082,
      "loadavg": [
        "9.00",
        "9.06",
        "9.73"
      ],
      "resource": {
        "completedAt": 1794399855048,
        "count": 144,
        "hostCount": 144,
        "status": "complete"
      }
    },
    {
      "utc": "2026-11-11T12:26:41.946452+00:00",
      "mono": 564055.0213578,
      "identity": "55984392",
      "runNs": 3794650925082,
      "queueNs": 15836126021,
      "rchar": 616898482630,
      "syscr": 137637341,
      "loadavg": [
        "22.13",
        "12.08",
        "10.68"
      ]
    },
    {
      "utc": "2026-11-11T12:27:41.948751+00:00",
      "mono": 564115.023663594,
      "identity": "55984392",
      "runNs": 3851039385655,
      "queueNs": 18490351378,
      "rchar": 628054820342,
      "syscr": 140298714,
      "loadavg": [
        "32.46",
        "17.29",
        "12.59"
      ]
    },
    {
      "utc": "2026-11-11T12:28:41.950308+00:00",
      "mono": 564175.025221443,
      "identity": "55984392",
      "runNs": 3908836902987,
      "queueNs": 19782579724,
      "rchar": 635854649286,
      "syscr": 142126843,
      "loadavg": [
        "30.46",
        "19.84",
        "13.79"
      ]
    },
    {
      "utc": "2026-11-11T12:29:41.951479+00:00",
      "mono": 564235.026383887,
      "identity": "55984392",
      "runNs": 3967806077419,
      "queueNs": 20180563210,
      "rchar": 653844214364,
      "syscr": 146517931,
      "loadavg": [
        "21.01",
        "19.20",
        "13.95"
      ]
    },
    {
      "utc": "2026-11-11T12:30:41.952606+00:00",
      "mono": 564295.027516009,
      "identity": "55984392",
      "runNs": 4027364932003,
      "queueNs": 20293623432,
      "rchar": 663915911127,
      "syscr": 148915643,
      "loadavg": [
        "18.51",
        "18.61",
        "14.07"
      ],
      "resource": {
        "completedAt": 1794399855048,
        "count": 144,
        "hostCount": 144,
        "status": "complete"
      }
    },
    {
      "utc": "2026-11-11T12:31:41.955477+00:00",
      "mono": 564355.030378703,
      "identity": "55984392",
      "runNs": 4086717053195,
      "queueNs": 20376608165,
      "rchar": 672302469964,
      "syscr": 150874862,
      "loadavg": [
        "16.83",
        "18.04",
        "14.15"
      ]
    },
    {
      "utc": "2026-11-11T12:32:41.956631+00:00",
      "mono": 564415.03154592,
      "identity": "55984392",
      "runNs": 4140826000210,
      "queueNs": 20623882783,
      "rchar": 681750663417,
      "syscr": 153070322,
      "loadavg": [
        "15.03",
        "17.27",
        "14.13"
      ]
    },
    {
      "utc": "2026-11-11T12:33:41.959060+00:00",
      "mono": 564475.033983875,
      "identity": "55984392",
      "runNs": 4198923548292,
      "queueNs": 21450680091,
      "rchar": 687771863358,
      "syscr": 154383598,
      "loadavg": [
        "20.93",
        "18.55",
        "14.77"
      ]
    },
    {
      "utc": "2026-11-11T12:34:41.960027+00:00",
      "mono": 564535.034933228,
      "identity": "55984392",
      "runNs": 4253537204352,
      "queueNs": 21704679315,
      "rchar": 696731926086,
      "syscr": 156547807,
      "loadavg": [
        "16.15",
        "17.64",
        "14.69"
      ]
    },
    {
      "utc": "2026-11-11T12:35:41.961291+00:00",
      "mono": 564595.036205751,
      "identity": "55984392",
      "runNs": 4312588821661,
      "queueNs": 21872503839,
      "rchar": 704436988383,
      "syscr": 158259513,
      "loadavg": [
        "16.18",
        "17.36",
        "14.78"
      ],
      "resource": {
        "completedAt": 1794399855048,
        "count": 144,
        "hostCount": 144,
        "status": "complete"
      }
    },
    {
      "utc": "2026-11-11T12:36:41.964002+00:00",
      "mono": 564655.038905875,
      "identity": "55984392",
      "runNs": 4370557204960,
      "queueNs": 22067396396,
      "rchar": 712799775335,
      "syscr": 160266257,
      "loadavg": [
        "14.80",
        "16.73",
        "14.72"
      ]
    }
  ]
}
```

The event journal retains only 20,000 rows. Its first segment can no longer be reproduced from the live store; the cutoff, selected sequence bounds, per-minute counts, kind counts and SHA-256 digests above preserve what was observed. The digest hashes the selected [seq,created_at,kind] rows as compact JSON. A future export cannot silently replace these cohorts.


Runtime event segment 1:

```bash
python3 - <<'PY'
import pathlib,sqlite3,time,datetime,json,collections,hashlib
root=pathlib.Path.home()/'.config/delegatus/state'
begin=datetime.datetime.now(datetime.timezone.utc).isoformat()
d=sqlite3.connect((root/'runtime-events-bb38046574072bf9.sqlite').as_uri()+'?mode=ro',uri=True,timeout=.25)
d.execute('PRAGMA query_only=ON'); deadline=time.monotonic()+3
d.set_progress_handler(lambda:int(time.monotonic()>deadline),1000)
first=d.execute('SELECT seq,created_at FROM events ORDER BY seq LIMIT 1').fetchone()
last=d.execute('SELECT seq,created_at FROM events ORDER BY seq DESC LIMIT 1').fetchone()
lo=int(datetime.datetime(2026,11,11,11,27,27,tzinfo=datetime.timezone.utc).timestamp()*1000)
hi=int(datetime.datetime(2026,11,11,12,14,tzinfo=datetime.timezone.utc).timestamp()*1000)
def seek(target):
 a,b=first[0],last[0]+1
 while a<b:
  mid=(a+b)//2;x=d.execute('SELECT seq,created_at FROM events WHERE seq>=? ORDER BY seq LIMIT 1',(mid,)).fetchone()
  if x is not None and x[1]<target:a=x[0]+1
  else:b=mid
 return a
s,e=seek(lo),seek(hi)
rows=d.execute('SELECT seq,created_at,kind FROM events WHERE seq>=? AND seq<? ORDER BY seq LIMIT 30001',(s,e)).fetchall()
assert len(rows)<=30000
v={'readStart':begin,'first':first,'last':last,'lo':lo,'hi':hi,'seqStart':s,'seqEnd':e,'complete':first[1]<=lo and last[1]>=hi,'rows':len(rows),'kinds':dict(collections.Counter(x[2] for x in rows)),'perMinute':dict(collections.Counter(str(x[1]//60000) for x in rows)),'changes':d.total_changes,'query_only':d.execute('PRAGMA query_only').fetchone()[0]}
v['perBin']=dict(collections.Counter(str((x[1]-int(datetime.datetime(2026,11,11,11,27,27,tzinfo=datetime.timezone.utc).timestamp()*1000))//600000) for x in rows))
v['rowsSHA256']=hashlib.sha256(json.dumps(rows,separators=(',',':')).encode()).hexdigest()
v['nonmonotonicPairs']=sum(b[1]<a[1] for a,b in zip(rows,rows[1:]))
v['rowTimeBounds']=[min((x[1] for x in rows),default=None),max((x[1] for x in rows),default=None)]
v['readEnd']=datetime.datetime.now(datetime.timezone.utc).isoformat()
print(json.dumps(v));d.close()
PY
```

Runtime event segment 2:

```bash
python3 - <<'PY'
import pathlib,sqlite3,time,datetime,json,collections,hashlib
root=pathlib.Path.home()/'.config/delegatus/state'
begin=datetime.datetime.now(datetime.timezone.utc).isoformat()
d=sqlite3.connect((root/'runtime-events-bb38046574072bf9.sqlite').as_uri()+'?mode=ro',uri=True,timeout=.25)
d.execute('PRAGMA query_only=ON'); deadline=time.monotonic()+3
d.set_progress_handler(lambda:int(time.monotonic()>deadline),1000)
first=d.execute('SELECT seq,created_at FROM events ORDER BY seq LIMIT 1').fetchone()
last=d.execute('SELECT seq,created_at FROM events ORDER BY seq DESC LIMIT 1').fetchone()
lo=int(datetime.datetime(2026,11,11,12,14,0,tzinfo=datetime.timezone.utc).timestamp()*1000)
hi=int(datetime.datetime(2026,11,11,12,37,23,816000,tzinfo=datetime.timezone.utc).timestamp()*1000)
def seek(target):
 a,b=first[0],last[0]+1
 while a<b:
  mid=(a+b)//2;x=d.execute('SELECT seq,created_at FROM events WHERE seq>=? ORDER BY seq LIMIT 1',(mid,)).fetchone()
  if x is not None and x[1]<target:a=x[0]+1
  else:b=mid
 return a
s,e=seek(lo),seek(hi)
rows=d.execute('SELECT seq,created_at,kind FROM events WHERE seq>=? AND seq<? ORDER BY seq LIMIT 30001',(s,e)).fetchall()
assert len(rows)<=30000
v={'readStart':begin,'first':first,'last':last,'lo':lo,'hi':hi,'seqStart':s,'seqEnd':e,'complete':first[1]<=lo and last[1]>=hi,'rows':len(rows),'kinds':dict(collections.Counter(x[2] for x in rows)),'perMinute':dict(collections.Counter(str(x[1]//60000) for x in rows)),'changes':d.total_changes,'query_only':d.execute('PRAGMA query_only').fetchone()[0]}
v['perBin']=dict(collections.Counter(str((x[1]-int(datetime.datetime(2026,11,11,11,27,27,tzinfo=datetime.timezone.utc).timestamp()*1000))//600000) for x in rows))
v['rowsSHA256']=hashlib.sha256(json.dumps(rows,separators=(',',':')).encode()).hexdigest()
v['nonmonotonicPairs']=sum(b[1]<a[1] for a,b in zip(rows,rows[1:]))
v['rowTimeBounds']=[min((x[1] for x in rows),default=None),max((x[1] for x in rows),default=None)]
v['readEnd']=datetime.datetime.now(datetime.timezone.utc).isoformat()
print(json.dumps(v));d.close()
PY
```

Lane reconstruction and final stored resource read:

```bash
python3 - <<'PY'
import pathlib,sqlite3,time,json,datetime,collections
def ms(s):return int(datetime.datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()*1000)
root=pathlib.Path.home()/'.config/delegatus/state';out={'readStart':datetime.datetime.now(datetime.timezone.utc).isoformat()}
d=sqlite3.connect((root/'state.sqlite').as_uri()+'?mode=ro',uri=True,timeout=.25);d.execute('PRAGMA query_only=ON');deadline=time.monotonic()+3;d.set_progress_handler(lambda:int(time.monotonic()>deadline),1000)
sql="SELECT h.row_key,h.startedMs,h.state,h.historical,h.stageId,h.n,json_extract(p.value_json,'$.state'),json_extract(p.value_json,'$.runs['||h.run||'].stageId'),json_extract(p.value_json,'$.runs['||h.run||'].attempts['||h.attempt||'].n'),json_extract(p.value_json,'$.runs['||h.run||'].attempts['||h.attempt||'].completedAt'),i.project FROM history_attempts h LEFT JOIN pipeline_ref_inputs p ON h.collection=p.collection AND h.row_key=p.row_key LEFT JOIN history_inputs i ON h.collection=i.collection AND h.row_key=i.row_key WHERE h.startedMs IS NOT NULL ORDER BY h.startedMs DESC LIMIT 20001"
rows=d.execute(sql).fetchall();assert len(rows)<=20000;valid=[];excluded=collections.Counter()
for key,start,state,historical,stage,n,pstate,pstage,pn,end,project in rows:
 if stage!=pstage or n!=pn:excluded['projection mismatch']+=1;continue
 if not end and not (state=='running' and pstate=='running' and not historical):excluded['missing end, not current running']+=1;continue
 valid.append((key,start,ms(end) if end else None,project))
own=d.execute("SELECT project FROM history_inputs WHERE collection=? AND row_key=? LIMIT 1",('pipelines','44d68e96')).fetchone()
assert own is not None
own_project=own[0]
hi=ms('2026-11-11T12:37:23.816Z')
windows=[('before',ms('2026-11-11T09:27:27Z')-(hi-ms('2026-11-11T11:27:27Z')),ms('2026-11-11T09:27:27Z')),('steady',ms('2026-11-11T11:27:27Z'),hi)]
out['windows']={}
for name,lo,hi in windows:
 samples=[]
 for t in range(lo,hi,60000):
  a=[(k,p) for k,s,e,p in valid if s<=t and (e is None or t<e)]
  samples.append([t,len(set(k for k,p in a)),len(set(k for k,p in a if p==own_project))])
 out['windows'][name]={'lo':lo,'hi':hi,'minuteSamples':samples}
out['rows']=len(rows);out['excluded']=dict(excluded);out['changes']=d.total_changes;out['query_only']=d.execute('PRAGMA query_only').fetchone()[0];d.close()
f=root/'resources-observation.json';assert f.stat().st_size<4194304;o=json.loads(f.read_text())['observation'];v=o['value'];s=v['payload']['sessions'];out['resource']={'completedAt':o['completedAt'],'count':len(s),'withRSS':sum(x.get('rssBytes',0)>0 for x in s),'hostCount':v['hostCount'],'status':v['diagnostic']['status']}
out['loadavg']=pathlib.Path('/proc/loadavg').read_text().split()[:3]
out['readEnd']=datetime.datetime.now(datetime.timezone.utc).isoformat()
print(json.dumps(out))

PY
```

Second short scheduler sample; the first used stat and schedstat without io:

```bash
python3 - <<'PY'
import pathlib,time,json,datetime
p=pathlib.Path('/proc/3875509/task/3875509');rows=[]
for n in range(13):
 stat=p.joinpath('stat').read_text();identity=stat[stat.rfind(')')+2:].split()[19]
 run,queue,slices=map(int,p.joinpath('schedstat').read_text().split())
 io={k:int(v.strip()) for k,v in (line.split(':',1) for line in p.joinpath('io').read_text().splitlines())}
 row={'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'mono':time.monotonic(),'identity':identity,'runNs':run,'queueNs':queue,'rchar':io['rchar'],'syscr':io['syscr']};rows.append(row)
 if n in [0,12]:print(json.dumps(row),flush=True)
 if n<12:time.sleep(5)
a,b=rows[0],rows[-1];assert a['identity']==b['identity']=='55984392';wall=b['mono']-a['mono']
print(json.dumps({'wallSeconds':wall,'runSeconds':(b['runNs']-a['runNs'])/1e9,'queueSeconds':(b['queueNs']-a['queueNs'])/1e9,'utilisationPercent':(b['runNs']-a['runNs'])/1e7/wall,'rcharPerSecond':(b['rchar']-a['rchar'])/wall,'readCallsPerSecond':(b['syscr']-a['syscr'])/wall,'samples':rows}),flush=True)
PY
```

Interrupted passive scheduler observation:

```bash
python3 - <<'PY'
import pathlib,time,json,datetime,os
target=pathlib.Path('/proc/3875509/task/3875509');root=pathlib.Path.home()/'.config/delegatus/state'
end=datetime.datetime(2026,11,11,13,0,tzinfo=datetime.timezone.utc).timestamp();rows=[]
print(json.dumps({'collectorPid':os.getpid(),'untilUTC':'2026-11-11T13:00:00Z','intervalSeconds':30}),flush=True)
while time.time()<end:
 stat=target.joinpath('stat').read_text();identity=stat[stat.rfind(')')+2:].split()[19]
 if identity!='55984392':print(json.dumps({'error':'target identity changed'}),flush=True);break
 run,queue,slices=map(int,target.joinpath('schedstat').read_text().split())
 io={k:int(v.strip()) for k,v in (line.split(':',1) for line in target.joinpath('io').read_text().splitlines())}
 row={'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'mono':time.monotonic(),'identity':identity,'runNs':run,'queueNs':queue,'rchar':io['rchar'],'syscr':io['syscr'],'loadavg':pathlib.Path('/proc/loadavg').read_text().split()[:3]}
 if len(rows)%10==0:
  p=root/'resources-observation.json';assert p.stat().st_size<4194304
  o=json.loads(p.read_text())['observation'];v=o['value'];row['resource']={'completedAt':o['completedAt'],'count':len(v['payload']['sessions']),'hostCount':v['hostCount'],'status':v['diagnostic']['status']}
 rows.append(row)
 if len(rows)%2==1:print(json.dumps({'sample':row}),flush=True)
 time.sleep(min(30,max(0,end-time.time())))
print(json.dumps({'complete':True,'readEnd':datetime.datetime.now(datetime.timezone.utc).isoformat(),'samples':rows}),flush=True)
PY
```

The process-name count used ps -eo comm=, a ten-second subprocess timeout and a 30,000-row refusal cap; it inspected 1,521 process rows. The session timestamps at 12:13:44.526 and 12:24:15.048 are also retained in the passive samples. Earlier acceptance counts are retained in the private acceptance report; this document publishes their aggregates.

</details>

<!-- load:end -->

Session observations are persisted resource-collector rows with their own
collection timestamps. They establish sampled load, with freshness stated,
and cannot reconstruct continuous host liveness. Lane concurrency is a
reconstruction from stored attempt intervals, sampled once per minute.
Historical attempts without an end and without a current running owner are
excluded. The resulting concurrency is a lower bound where those records
are incomplete. Runtime-event rate is recorded before retention removes its
early rows. Events count journal records, including intermediate engine
items.

The private acceptance report, `$HOME/.local/share/delegatus-evidence/post-deploy-692e5338-acceptance.md`,
was read in full. Its E05 and E06 commands measured 23.8026% at
08:00:00 to 08:30:00 on `803f12c1`, and 29.6788% at 11:17:27 to 11:47:27 on
`692e5338`. Those figures describe the initial comparison and retain its
startup and load limitations. The longer comparison above is the reference
for this document. Its load differences prevent a causal release comparison.

## 2. Attribution of the recorded gap time

`reads.namedSyncMs` sums exclusive synchronous frames on the serving thread.
Each child is subtracted from its enclosing frame by `readAttribution.ts`.
The retained top list contains at most 16 rows selected by bytes. Time-ranked
readers below are ranked within that retained set. Worker CPU
(`workerSyncMs`) is excluded; receiving or decoding a worker's
message on the serving thread remains eligible. The `operation` reader is
the measured synchronous body outside its child readers.

For each record, attributed time is `min(gapMs, reads.namedSyncMs)` and the
unattributed residual is `max(0, gapMs - reads.namedSyncMs)`. Visible reader
families are scaled by that cap when necessary. The difference between the
main-thread total and its visible top rows is retained as a separate named
share. It has a measured duration and an unavailable family. Truncated
records are wholly unknown. Dropped reader time is reported separately;
it cannot safely be added because the dropped counter can include worker
transport. The ordinary timer interval and scalar rounding leave a small
boundary uncertainty, quantified with the final measurements.

Synchronous span intervals are clipped to `[lastTick,tick]`, then unioned.
Nested spans and repeated span identities count once. Coalesced tiny spans
may contain holes: their interval union is an upper envelope, while
`totalMs` records occupied time. These spans also run through the reader
counter. Adding their union to `namedSyncMs` would count the same work twice.
Async operation ages, awaited spans, transaction holds and lock waits are
context, and receive no additional synchronous-time credit.

<!-- attribution:start -->
| Exclusive reader family | Seconds | Share of all Viewer gap time | Seconds in gaps >=1 s | Share of all Viewer gap time |
| --- | --- | --- | --- | --- |
| Unattributed | 795.730 | 72.6293% | 579.393 | 52.8834% |
| Registry readers | 99.329 | 9.0661% | 67.639 | 6.1737% |
| State readers | 80.398 | 7.3383% | 54.463 | 4.9711% |
| Operation bodies | 43.413 | 3.9624% | 28.497 | 2.6010% |
| Other named readers | 32.281 | 2.9464% | 10.012 | 0.9138% |
| Role-memory readers | 30.032 | 2.7411% | 15.910 | 1.4522% |
| Named beyond visible top | 14.423 | 1.3164% | 7.233 | 0.6602% |

The unattributed residual is **795.730 seconds (72.6293% of all recorded Viewer gap time)**. Gaps of at least one second account for 763.147 seconds across 309 records; their residual is 579.393 seconds. Shorter gaps remain in the total denominator.

The synchronous span union is 111.737 seconds; summing nested envelopes would give 121.702 seconds. Coalesced envelopes contain up to 5.537 seconds beyond their recorded occupied durations. All are diagnostic cross-checks beside the exclusive counters. Reader drops report 7.583 seconds with mixed provenance; they remain inside the residual uncertainty. The ten-millisecond timer interval plus gap rounding permits up to 8.411 seconds of boundary uncertainty in this allocation.

Cooperative fields survive in 799 records: resumed=0 in 121, resumed<=2 in 558; maximum observed queue depth 23, longest wait 18914 ms. There are 54 distinct watchdog trigger sequences, 50 naming unknown-runtime-or-native. Repeated trigger appearances across gap reports count once.

Scheduler run time sums to 1,161.411 seconds beside 1,094.479 seconds of gap time in records with scheduler coverage. The sampling window includes a lead margin and is wider than the excess gap; this ratio can exceed 100%. It establishes no exclusive CPU allocation. The independent scheduler-counter measurements in section 1 use matching wall-clock boundaries.

Largest records:

| UTC | Gap ms | Named ms | Residual ms | Main-thread run ms | Resumed/turns | Largest three visible readers (operation:reader, ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 11:40:46.547 | 16078 | 1,517.842 | 14,560.158 | 16,176.736 | 0/0 | registry.read:registry.keyed 729.5; scanner.worker:scanner.ipc-frame 255.7; registry.read:registry.get 143.2 |
| 11:34:32.798 | 14956 | 1,333.525 | 13,622.475 | 14,962.483 | 0/0 | registry.read:registry.keyed 565.2; scanner.worker:scanner.ipc-frame 265.8; registry.read:registry.get 111.0 |
| 12:31:33.632 | 14866 | 5,161.539 | 9,704.461 | 14,896.623 | 2/1 | http.render:registry.get 2254.5; http.render:registry.json 2203.3; scanner.worker:scanner.ipc-frame 351.7 |
| 11:47:12.330 | 14728 | 1,345.467 | 13,382.533 | 14,716.750 | 0/0 | registry.read:registry.keyed 590.0; scanner.worker:scanner.ipc-frame 253.0; registry.read:registry.get 110.4 |
| 11:31:24.157 | 13799 | 1,426.213 | 12,372.787 | 13,883.987 | 0/0 | registry.read:registry.keyed 505.3; scanner.worker:scanner.ipc-frame 270.2; registry.read:registry.snapshot 245.6 |
| 11:53:31.080 | 13605 | 1,006.509 | 12,598.491 | 13,564.536 | 0/0 | registry.read:registry.keyed 421.5; scanner.worker:scanner.ipc-frame 256.5; registry.read:registry.get 74.7 |
| 12:03:36.799 | 13502 | 1,076.986 | 12,425.014 | 13,475.928 | 0/0 | registry.read:registry.keyed 426.1; registry.read:registry.snapshot 176.7; seat.panel:state.all 114.2 |
| 12:30:12.201 | 10526 | 3,296.169 | 7,229.831 | 10,594.875 | 1/1 | http.render:registry.json 1537.7; http.render:registry.get 1498.6; http.render:registry.prepare 137.8 |

Top measured operation contexts, across visible exclusive readers (a second view of the same time):

| Operation | Seconds | Share of all gap time |
| --- | --- | --- |
| registry.read | 67.827 | 6.1908% |
| memory.import.curation | 31.739 | 2.8969% |
| http.render | 23.564 | 2.1507% |
| seat-tick.check | 22.090 | 2.0162% |
| role-memory.view | 18.540 | 1.6922% |
| scanner.worker | 16.439 | 1.5004% |
| state.document | 10.775 | 0.9835% |
| pipelines.mutation | 9.830 | 0.8972% |
| registry.write | 9.348 | 0.8532% |
| mcp.page-cursors | 8.237 | 0.7518% |
| hosts.retirement | 8.004 | 0.7306% |
| seat.panel | 7.462 | 0.6810% |

GC telemetry states: {'gc-entry-unsupported': 799, 'unavailable-record': 2}. The residual includes omitted measurements and instrumentation overhead. GC duration remains unavailable.

JS-profile record states: absent: 684, not-armed/profiler-not-started: 117. Missing profile fields in short records are reported as absent.

<!-- attribution:end -->

### Every gap of at least one second

<!-- ledger:start -->
<details>
<summary>Complete gap and lock-context ledger</summary>

Each row is one gap, ordered by UTC. All durations are milliseconds. N/U is named/residual; union/max is the retained synchronous span union and longest individual slice; R/T D/M W is cooperative resumed/turns, current/max depth and longest wait. S is the retained watchdog trigger sequence. T and L refer to the context tables below. Three largest visible reader rows are shown; remaining visible rows and the named tail contribute to N. Operation names identify the stored context; an HTTP route URI or original worker caller is unavailable where the record carries only a generic label.

| UTC; sequence | Gap; N/U | Readers: operation / reader / ms | union/max | R/T D/M W; S | run ms | Hold context |
| --- | --- | --- | --- | --- | --- | --- |
| 11:27:38.651; 120 | 1359; 100.5/1258.5 | seat-tick.check/state.exec/38.9; seat-tick.check/state.prepare/18.6; seat-tick.check/state.close/13.5; +13 rows | 62.8/8.7 | 3/1 8/8 1579; S9 | 1381.1 | T1,L1 |
| 11:27:40.215; 121 | 1398; 114.0/1284.0 | seat-tick.check/state.exec/34.7; seat.panel/operation/29.1; seat-tick.check/state.prepare/13.1; +13 rows | 59.4/8.7 | 1/1 8/8 2969; S9 | 1466.3 | T1,T2,L1 |
| 11:27:59.710; 124 | 1809; 1016.3/792.7 | role-memory.view/state.get/342.6; scanner.worker/scanner.ipc-frame/275.4; role-memory.view/state.json/238.1; +13 rows | 279.1/25.7 | 12/12 1/1 3; S10 | 1835.0 | none recorded nearby |
| 11:28:16.563; 130 | 1741; 91.0/1650.0 | registry.read/registry.snapshot/51.6; seat.panel/operation/15.3; registry.read/registry.keyed/5.0; +13 rows | 70.8/56.8 | 2/1 3/3 1664; S10 | 1890.6 | T6 |
| 11:28:19.922; 131 | 1544; 1411.8/132.2 | memory.engine-start/state.write-wait/1390.7; registry.read/registry.keyed/9.0; seat-tick.check/registry.keyed/1.3; +13 rows | 1408.0/1390.8 | 11/11 1/1 1463; S10 | 1593.1 | T7 |
| 11:28:23.526; 132 | 1395; 1238.0/157.0 | controller.account-migration/operation/717.6; registry.read/registry.keyed/174.1; controller.account-migration/registry.get/97.3; +13 rows | 400.0/37.0 | 1/1 2/2 223; S10 | 1464.4 | none recorded nearby |
| 11:28:42.955; 137 | 1952; 593.6/1358.4 | pipelines.mutation/pipeline.copy/211.0; registry.read/registry.snapshot/138.4; registry.read/registry.keyed/55.5; +13 rows | 339.5/107.4 | 3/1 5/5 1417; S10 | 1939.9 | T8,L2 |
| 11:28:44.692; 138 | 1275; 652.2/622.8 | pipelines.mutation/pipeline.copy/217.3; mcp.page-cursors/pipeline.copy/174.1; registry.read/registry.keyed/48.2; +13 rows | 251.3/34.8 | 1/1 4/5 1706; S10 | 1225.7 | T9 |
| 11:28:46.674; 140 | 1078; 458.8/619.2 | pipelines.mutation/pipeline.copy/199.2; mcp.page-cursors/memory.view.all/97.4; registry.read/registry.keyed/50.8; +13 rows | 130.3/8.5 | 1/1 6/7 1128; S10 | 1167.5 | T10,T11 |
| 11:28:51.318; 142 | 1037; 824.0/213.0 | registry.read/registry.snapshot/442.7; scanner.worker/scanner.ipc-frame/187.6; registry.read/registry.keyed/58.8; +13 rows | 727.1/461.7 | 2/1 5/5 990; S10 | 1082.2 | none recorded nearby |
| 11:30:38.607; 160 | 2689; 1280.9/1408.1 | seat-tick.check/state.json/441.4; memory.curation-status/memory.view.iterate/208.9; seat-tick.check/state.all/204.2; +13 rows | 34.0/3.5 | 2/2 1/1 2494; S11 | 2796.2 | none recorded nearby |
| 11:30:40.924; 161 | 1139; 150.4/988.6 | pipelines.mutation/state.exec/43.3; pipelines.mutation/state.run/27.9; pipelines.mutation/state.prepare/18.7; +13 rows | 69.2/10.4 | 2/2 1/1 28; S11 | 1122.2 | T18 |
| 11:30:45.707; 165 | 1474; 68.9/1405.1 | seat.panel/operation/25.7; memory.curation-panel/memory.view.all/13.2; state.document/state.exec/6.2; +13 rows | 21.2/2.9 | 2/1 2/3 1372; S11 | 1588.5 | none recorded nearby |
| 11:30:49.598; 166 | 1637; 332.4/1304.6 | registry.write/registry.conversations.all/160.3; registry.write/registry.json/72.4; registry.read/registry.snapshot/42.7; +13 rows | 74.5/43.4 | 3/3 1/1 35; S11 | 1794.6 | none recorded nearby |
| 11:30:52.304; 168 | 1663; 263.0/1400.0 | pipelines.controller-schedule/registry.get/90.0; pipelines.controller-schedule/registry.json/57.9; pipelines.mutation/state.exec/18.7; +13 rows | 83.0/17.4 | 2/1 2/2 117; S11 | 1797.3 | none recorded nearby |
| 11:31:24.157; 170 | 13799; 1426.2/12372.8 | registry.read/registry.keyed/505.3; scanner.worker/scanner.ipc-frame/270.2; registry.read/registry.snapshot/245.6; +13 rows | 524.4/257.1 | 0/0 1/1 0; S11 | 13884.0 | none recorded nearby |
| 11:31:27.168; 172 | 1785; 338.1/1446.9 | pipelines.controller-schedule/pipeline.copy/140.7; registry.read/registry.snapshot/33.6; pipelines.mutation/state.exec/33.3; +13 rows | 198.1/42.0 | 3/1 3/3 1070; S11 | 1804.4 | T19 |
| 11:31:29.555; 174 | 1054; 121.4/932.6 | http.render/state.all/53.6; pipelines.mutation/state.exec/14.4; http.render/state.exec/5.3; +13 rows | 42.6/3.5 | 2/1 2/2 699; S11 | 1194.5 | none recorded nearby |
| 11:31:38.613; 176 | 6994; 577.1/6416.9 | registry.read/registry.keyed/284.4; registry.read/registry.get/54.6; seat.panel/state.all/53.5; +13 rows | 47.0/12.0 | 17/17 1/1 6708; S12 | 7080.6 | none recorded nearby |
| 11:31:41.424; 177 | 1648; 340.4/1307.6 | registry.write/registry.conversations.all/153.8; registry.write/registry.json/69.1; registry.read/registry.snapshot/34.4; +13 rows | 86.9/34.9 | 1/1 1/1 7; S12 | 1682.7 | none recorded nearby |
| 11:31:50.357; 180 | 5274; 263.3/5010.7 | registry.read/registry.keyed/160.8; registry.read/registry.get/32.7; registry.read/operation/25.8; +13 rows | 17.5/0.7 | 15/15 1/1 0; S12 | 5308.2 | none recorded nearby |
| 11:32:05.293; 181 | 1209; 148.0/1061.0 | pipelines.mutation/state.exec/45.0; pipelines.mutation/state.run/24.8; pipelines.mutation/state.prepare/21.5; +13 rows | 66.5/4.6 | 1/1 1/1 4; S12 | 1311.7 | T21 |
| 11:32:10.249; 185 | 1353; 65.0/1288.0 | registry.read/registry.snapshot/21.5; seat.panel/operation/13.4; state.document/state.exec/6.2; +13 rows | 45.6/26.0 | 1/1 3/3 1380; S12 | 1486.6 | none recorded nearby |
| 11:32:14.900; 187 | 1615; 320.1/1294.9 | registry.write/registry.conversations.all/150.6; registry.read/registry.snapshot/56.8; registry.write/registry.json/56.8; +13 rows | 91.0/57.6 | 2/1 2/2 17; S12 | 1793.8 | none recorded nearby |
| 11:32:16.693; 188 | 1034; 82.0/952.0 | pipelines.mutation/state.exec/17.4; registry.read/registry.snapshot/13.5; orchestrator.seat-channel/state.exec/8.0; +13 rows | 104.5/13.7 | 2/1 2/2 61; S12 | 1098.1 | none recorded nearby |
| 11:32:57.108; 196 | 1075; 199.7/875.3 | seat.panel/operation/28.6; seat-tick.check/state.exec/25.4; registry.read/registry.snapshot/20.1; +13 rows | 87.4/20.7 | 2/1 3/3 1103; S13 | 1187.5 | T24 |
| 11:32:59.775; 197 | 2442; 387.9/2054.1 | seat-tick.check/state.exec/83.6; pipelines.mutation/state.exec/48.1; seat-tick.check/state.prepare/47.5; +13 rows | 136.0/4.9 | 2/1 3/3 1290; S13 | 2470.6 | T24,T25 |
| 11:33:00.861; 198 | 1077; 358.9/718.1 | pipelines.controller-schedule/pipeline.copy/123.8; seat.panel/state.all/60.3; seat.panel/operation/41.2; +13 rows | 199.0/38.2 | 1/1 3/3 2583; S13 | 1086.7 | T25 |
| 11:33:01.962; 199 | 1089; 453.9/635.1 | scanner.worker/scanner.ipc-frame/318.1; registry.read/registry.snapshot/22.8; scanner.worker/scanner.ipc-decode/18.8; +13 rows | 342.2/31.9 | 2/1 3/3 2731; S13 | 1195.9 | T25 |
| 11:33:04.811; 202 | 1438; 265.8/1172.2 | pipelines.mutation/pipeline.copy/124.5; prototype.state/operation/30.3; pipelines.mutation/state.exec/21.5; +13 rows | 93.1/8.0 | 1/1 3/3 2609; S13 | 1577.6 | T26 |
| 11:33:11.618; 204 | 2151; 521.7/1629.3 | registry.write/registry.conversations.all/273.4; registry.write/registry.json/77.5; registry.read/registry.snapshot/74.1; +13 rows | 124.6/75.2 | 3/1 2/3 85; S13 | 2281.9 | none recorded nearby |
| 11:33:15.055; 205 | 2435; 431.9/2003.1 | registry.read/registry.snapshot/156.5; pipelines.controller-schedule/registry.get/108.4; pipelines.controller-schedule/registry.json/75.5; +13 rows | 237.9/153.9 | 1/1 1/2 60; S13 | 2497.6 | none recorded nearby |
| 11:33:29.175; 207 | 1658; 35.7/1622.3 | pipelines.controller-job/state.exec/8.4; delivery-progress.restore/delivery-progress.restore.slice/3.8; runtime.startup/runtime.startup.select/3.2; +13 rows | 31.9/8.0 | 1/1 1/1 1633; S13 | 1796.9 | T27,L3 |
| 11:33:44.799; 209 | 2205; 1933.1/271.9 | registry.read/registry.keyed/979.6; registry.read/registry.all/347.5; runtime.startup/registry.conversations.all/126.1; +13 rows | 98.1/5.4 | 2/1 1/2 45; S13 | 2301.6 | none recorded nearby |
| 11:34:32.798; 214 | 14956; 1333.5/13622.5 | registry.read/registry.keyed/565.2; scanner.worker/scanner.ipc-frame/265.8; registry.read/registry.get/111.0; +13 rows | 307.5/47.1 | 0/0 1/1 0; S14 | 14962.5 | none recorded nearby |
| 11:34:35.737; 215 | 1729; 365.2/1363.8 | pipelines.controller-schedule/pipeline.copy/78.5; seat.panel/state.all/69.8; pipelines.mutation/state.exec/39.2; +13 rows | 156.5/7.1 | 3/1 4/4 1089; S14 | 1882.5 | T29 |
| 11:34:43.391; 219 | 3603; 1630.9/1972.1 | memory.import.curation/operation/559.5; memory.import.curation/memory.view.all/244.2; memory.import.curation/memory.view.iterate/229.3; +13 rows | 150.1/45.9 | 4/1 5/5 3396; S14 | 3665.7 | T30,T31 |
| 11:34:54.248; 221 | 8048; 613.0/7435.0 | registry.read/registry.keyed/349.7; registry.read/registry.get/64.7; registry.read/operation/58.8; +13 rows | 41.7/3.7 | 6/6 1/1 7782; S14 | 8098.0 | T32 |
| 11:34:55.833; 222 | 1575; 498.0/1077.0 | registry.read/registry.snapshot/302.7; registry.read/registry.keyed/33.2; memory.view.all/memory.view.all/27.6; +13 rows | 370.6/304.5 | 2/1 17/18 1814; S14 | 1690.4 | none recorded nearby |
| 11:34:59.812; 224 | 2821; 545.7/2275.3 | registry.write/registry.conversations.all/211.6; registry.write/registry.json/113.7; registry.read/registry.snapshot/76.3; +13 rows | 157.3/77.5 | 1/1 17/17 1410; S14 | 2888.4 | none recorded nearby |
| 11:35:03.821; 226 | 1648; 245.5/1402.5 | pipelines.mutation/state.exec/51.2; transcript.index/transcript.index/50.2; pipelines.mutation/state.run/24.6; +13 rows | 130.1/47.3 | 1/1 18/19 6617; S14 | 1682.1 | T33 |
| 11:35:05.023; 227 | 1192; 398.2/793.8 | pipelines.controller-schedule/pipeline.copy/109.9; registry.read/registry.snapshot/98.1; registry.read/registry.keyed/44.4; +13 rows | 253.3/85.2 | 1/1 18/18 8356; S14 | 1255.1 | T33 |
| 11:35:06.693; 228 | 1659; 336.9/1322.1 | delivery-progress.restore/delivery-progress.restore.slice/69.1; seat.panel/state.all/62.0; seat.panel/operation/41.9; +13 rows | 130.6/69.1 | 2/1 18/18 9329; S14 | 1753.7 | T33 |
| 11:35:09.202; 230 | 1133; 127.7/1005.3 | registry.read/registry.snapshot/30.1; pipelines.mutation/state.exec/19.2; prototype.state/operation/19.2; +13 rows | 78.8/18.0 | 1/1 18/19 7795; S14 | 1294.7 | none recorded nearby |
| 11:35:14.530; 231 | 1816; 393.2/1422.8 | registry.write/registry.conversations.all/214.8; registry.write/registry.json/68.0; registry.read/registry.snapshot/38.4; +13 rows | 78.9/39.2 | 4/1 4/4 50; S14 | 1883.7 | none recorded nearby |
| 11:35:16.811; 232 | 1212; 87.6/1124.4 | pipelines.mutation/state.exec/23.7; registry.read/registry.snapshot/13.5; prototype.state/operation/5.2; +13 rows | 62.1/13.6 | 2/1 13/14 383; S14 | 1292.3 | none recorded nearby |
| 11:35:23.064; 234 | 1032; 355.9/676.1 | registry.read/registry.snapshot/110.7; seat-tick.check/operation/66.9; registry.read/registry.keyed/23.0; +13 rows | 221.7/119.1 | 1/1 13/13 2047; S14 | 1095.2 | none recorded nearby |
| 11:35:27.628; 235 | 2575; 1022.3/1552.7 | http.render/state.json/419.6; http.render/state.iterate/392.4; http.render/memory.view.all/48.9; +13 rows | 90.1/15.9 | 5/1 13/13 2796; S15 | 2690.6 | T35,T36,L4 |
| 11:35:38.497; 237 | 6459; 558.1/5900.9 | registry.read/registry.keyed/240.3; seat.panel/state.all/71.9; seat.panel/operation/68.4; +13 rows | 52.2/18.0 | 21/3 7/7 6111; S15 | 6496.7 | T37 |
| 11:35:40.273; 238 | 1768; 166.6/1601.4 | registry.read/registry.snapshot/38.3; seat-tick.check/state.exec/31.9; seat-tick.check/state.prepare/14.3; +13 rows | 316.6/26.7 | 8/1 9/10 1623; S15 | 1870.2 | T37,T38 |
| 11:35:41.840; 239 | 1558; 226.2/1331.8 | http.render/pipeline.copy/69.6; seat-tick.check/state.exec/26.2; registry.read/registry.keyed/18.4; +13 rows | 173.1/11.6 | 1/1 12/12 2902; S15 | 1685.1 | T38,T39 |
| 11:35:52.290; 240 | 2046; 748.9/1297.1 | role-memory.view/state.json/378.9; role-memory.view/state.get/195.9; role-memory.view/memory.view.all/55.3; +13 rows | 49.5/9.8 | 9/3 5/5 5; S15 | 2178.4 | T40 |
| 11:35:56.635; 241 | 4057; 891.9/3165.1 | http.render/memory.view.all/147.6; role-memory.view/memory.view.all/115.0; seat.panel/state.all/96.7; +13 rows | 178.2/32.6 | 1/1 6/6 4092; S15 | 4035.4 | T40,T41,L5 |
| 11:35:58.385; 242 | 1736; 259.8/1476.2 | orchestrator.seat-channel/state.exec/65.9; prototype.state/operation/58.3; seat-tick.check/state.exec/22.3; +13 rows | 156.8/52.3 | 2/1 7/8 5887; S15 | 1829.5 | T41,L5 |
| 11:36:05.469; 245 | 2486; 950.7/1535.3 | role-memory.view/state.json/446.3; role-memory.view/state.get/265.9; role-memory.view/memory.view.all/59.9; +13 rows | 93.9/59.2 | 3/1 3/3 9; S15 | 2515.1 | none recorded nearby |
| 11:36:12.595; 250 | 1064; 578.9/485.1 | registry.read/registry.snapshot/392.7; seat.panel/operation/121.5; registry.read/registry.deliveryOperationOwners.iterate/12.6; +13 rows | 423.4/407.0 | 2/1 2/2 814; S15 | 1104.6 | none recorded nearby |
| 11:36:30.002; 252 | 3219; 984.1/2234.9 | role-memory.view/state.json/512.3; role-memory.view/state.get/224.0; seat.panel/operation/92.5; +13 rows | 64.3/8.7 | 2/1 2/2 2; S16 | 3247.3 | none recorded nearby |
| 11:37:23.963; 270 | 1902; 1777.8/124.2 | hosts.retirement/operation/1161.3; seat.panel/state.all/106.1; hosts.retirement/registry.get/100.6; +13 rows | 67.8/6.8 | 1/1 2/2 1565; S16 | 1955.9 | none recorded nearby |
| 11:37:26.316; 271 | 1377; 245.6/1131.4 | memory.view.all/memory.view.all/68.3; registry.read/registry.keyed/29.7; pipelines.retirement-evidence/state.json/28.9; +13 rows | 85.1/26.7 | 4/2 17/17 1298; S16 | 1493.2 | none recorded nearby |
| 11:37:51.392; 274 | 2235; 184.3/2050.7 | seat-tick.check/state.exec/70.6; seat.panel/operation/29.4; seat-tick.check/state.prepare/29.2; +13 rows | 98.3/11.4 | 2/1 4/4 2318; S17 | 2282.2 | T42,T43 |
| 11:38:14.999; 280 | 2871; 476.9/2394.1 | seat-tick.check/state.exec/154.5; seat-tick.check/state.prepare/86.5; seat-tick.check/state.close/51.3; +13 rows | 191.6/8.3 | 1/1 2/2 2742; S17 | 2877.2 | T44 |
| 11:38:38.257; 282 | 1938; 1686.6/251.4 | memory.import.curation/operation/603.6; memory.import.curation/memory.view.all/266.7; memory.import.curation/memory.view.iterate/236.3; +13 rows | 88.0/4.3 | 1/1 1/1 1891; S17 | 2092.5 | T45,T46 |
| 11:38:52.820; 284 | 2247; 136.0/2111.0 | seat.panel/operation/41.1; pipelines.controller-job/state.json/20.5; pipelines.controller-job/state.exec/12.9; +13 rows | 39.9/5.2 | 2/2 2/2 2071; S18 | 2393.1 | T48,L6 |
| 11:39:21.509; 286 | 1503; 561.1/941.9 | role-memory.view/state.json/265.7; role-memory.view/state.get/141.2; role-memory.view/memory.view.all/99.4; +13 rows | 12.3/4.2 | 13/13 1/1 10; S18 | 1597.7 | none recorded nearby |
| 11:39:37.347; 287 | 2039; 1781.1/257.9 | registry.read/registry.keyed/892.6; registry.read/registry.all/291.2; runtime.startup/registry.conversations.all/109.5; +13 rows | 93.2/3.9 | 0/0 0/0 0; S18 | 2080.5 | none recorded nearby |
| 11:39:51.304; 289 | 6373; 5921.0/452.0 | memory.import.curation/operation/2453.3; memory.import.curation/state.run/928.1; memory.import.curation/state.json/520.4; +13 rows | 100.9/7.5 | 0/0 0/0 0; S18 | 6409.8 | T49,T50,L7,L8 |
| 11:39:56.194; 291 | 1244; 563.2/680.8 | seat-tick.prepare/state.json/274.7; seat-tick.prepare/state.all/124.0; memory.view.all/memory.view.all/57.1; +13 rows | 20.3/2.2 | 2/1 16/16 1169; S19 | 1391.5 | none recorded nearby |
| 11:40:18.460; 296 | 1403; 225.9/1177.1 | seat.panel/state.all/61.6; seat.panel/operation/52.3; seat-tick.check/state.exec/40.6; +13 rows | 67.5/9.4 | 3/1 3/3 1467; S19 | 1493.8 | T52,T53 |
| 11:40:46.547; 297 | 16078; 1517.8/14560.2 | registry.read/registry.keyed/729.5; scanner.worker/scanner.ipc-frame/255.7; registry.read/registry.get/143.2; +13 rows | 270.2/27.6 | 0/0 1/1 0; S19 | 16176.7 | none recorded nearby |
| 11:40:58.233; 299 | 7440; 603.0/6837.0 | registry.read/registry.keyed/296.6; seat.panel/operation/100.9; registry.read/registry.get/59.1; +13 rows | 65.1/7.5 | 2/1 3/3 7110; S20 | 7583.3 | none recorded nearby |
| 11:41:01.773; 301 | 2974; 500.5/2473.5 | seat-tick.check/state.exec/123.9; http.render/state.all/59.6; seat-tick.check/state.prepare/59.0; +13 rows | 172.9/17.6 | 2/1 3/3 2425; S20 | 3078.5 | T54 |
| 11:41:15.274; 303 | 6844; 512.5/6331.5 | registry.read/registry.keyed/308.5; registry.read/registry.get/61.6; registry.read/operation/53.6; +13 rows | 27.0/2.3 | 7/3 4/4 17; S20 | 7008.2 | none recorded nearby |
| 11:41:24.940; 304 | 2330; 977.1/1352.9 | role-memory.view/state.json/416.0; role-memory.view/state.get/219.3; role-memory.view/memory.view.all/183.4; +13 rows | 27.2/2.9 | 2/1 6/6 24; S20 | 2394.3 | none recorded nearby |
| 11:41:44.249; 306 | 1604; 625.1/978.9 | role-memory.view/state.json/285.8; role-memory.view/state.get/152.6; role-memory.view/memory.view.all/94.8; +13 rows | 13.3/1.0 | 4/3 5/5 40; S20 | 1681.7 | none recorded nearby |
| 11:42:07.524; 308 | 2339; 420.3/1918.7 | mcp.page-cursors/memory.view.all/88.1; seat.panel/state.all/82.0; pipelines.mutation/state.exec/56.4; +13 rows | 137.4/20.0 | 1/1 2/2 421; S21 | 2272.6 | T55 |
| 11:42:12.269; 313 | 1258; 157.0/1101.0 | mcp.page-cursors/memory.view.all/53.5; registry.read/registry.keyed/16.0; pipelines.mutation/state.exec/11.9; +13 rows | 61.5/3.7 | 1/1 3/4 2453; S21 | 1388.2 | none recorded nearby |
| 11:42:19.813; 316 | 2216; 507.5/1708.5 | registry.write/registry.conversations.all/202.3; registry.write/registry.json/79.9; mcp.page-cursors/memory.view.all/48.1; +13 rows | 112.9/45.1 | 2/1 3/3 467; S21 | 2296.8 | none recorded nearby |
| 11:42:23.398; 318 | 1969; 307.2/1661.8 | pipelines.controller-schedule/registry.get/103.2; pipelines.controller-schedule/registry.json/73.2; pipelines.mutation/state.exec/19.2; +13 rows | 83.0/15.2 | 2/1 5/5 538; S21 | 2099.8 | none recorded nearby |
| 11:42:25.907; 320 | 1369; 433.9/935.1 | registry.read/registry.snapshot/206.2; mcp.page-cursors/memory.view.all/56.1; registry.read/registry.keyed/34.8; +13 rows | 299.7/198.9 | 2/1 6/6 4062; S21 | 1480.6 | none recorded nearby |
| 11:42:27.193; 321 | 1277; 238.6/1038.4 | memory.view.all/memory.view.all/46.7; seat.panel/operation/38.4; prototype.state/state.all/32.1; +13 rows | 44.2/3.1 | 2/1 21/21 2954; S21 | 1385.1 | none recorded nearby |
| 11:42:34.476; 322 | 2347; 494.8/1852.2 | pipelines.controller-schedule/registry.get/250.8; pipelines.controller-schedule/registry.json/171.0; pipelines.controller-schedule/registry.prepare/34.7; +13 rows | 43.1/6.8 | 1/1 19/20 3137; S21 | 2397.8 | none recorded nearby |
| 11:42:51.361; 325 | 1193; 47.3/1145.7 | resources.read/cache.accounting/18.2; resources.read/registry.conversations.all/7.7; resources.read/registry.get/6.1; +13 rows | 7.1/1.2 | 1/1 9/9 450; S21 | 1298.4 | none recorded nearby |
| 11:42:55.173; 326 | 1954; 322.3/1631.7 | seat.panel/state.all/113.2; seat.panel/operation/73.9; seat-tick.check/state.exec/44.4; +13 rows | 77.7/4.9 | 2/1 9/9 2040; S21 | 1960.4 | T57,T58 |
| 11:43:37.630; 330 | 2485; 1236.7/1248.3 | seat-tick.check/state.json/436.8; memory.curation-status/memory.view.iterate/224.2; seat-tick.check/state.all/183.9; +13 rows | 18.2/2.6 | 2/2 3/4 22; S22 | 2601.0 | none recorded nearby |
| 11:44:26.318; 332 | 1183; 175.0/1008.0 | pipelines.mutation/state.exec/40.5; registry.read/registry.snapshot/26.8; pipelines.mutation/state.run/25.0; +13 rows | 96.9/27.3 | 2/2 1/1 13; S22 | 1214.6 | T60 |
| 11:44:29.678; 335 | 1020; 135.6/884.4 | prototype.state/state.json/18.8; prototype.state/operation/13.5; pipelines.mutation/state.exec/12.5; +13 rows | 78.9/11.9 | 2/1 2/2 743; S22 | 1193.7 | none recorded nearby |
| 11:44:34.361; 338 | 1868; 387.2/1480.8 | registry.write/registry.conversations.all/197.5; registry.write/registry.json/68.4; registry.read/registry.snapshot/54.2; +13 rows | 93.5/55.1 | 4/4 1/1 19; S22 | 1894.6 | none recorded nearby |
| 11:44:36.370; 340 | 1217; 76.0/1141.0 | pipelines.mutation/state.exec/20.6; registry.read/registry.snapshot/13.9; registry.read/registry.keyed/5.3; +13 rows | 107.6/14.0 | 1/1 1/1 14; S23 | 1298.6 | none recorded nearby |
| 11:44:57.394; 344 | 1474; 169.2/1304.8 | memory.view.all/memory.view.all/54.5; registry.read/registry.keyed/26.0; seat-tick.check/operation/22.0; +13 rows | 35.4/1.2 | 2/1 17/17 32; S23 | 1598.1 | none recorded nearby |
| 11:45:39.249; 350 | 2022; 559.0/1463.0 | registry.read/registry.snapshot/212.1; seat-tick.check/state.exec/126.5; seat-tick.check/state.prepare/59.8; +13 rows | 357.6/227.7 | 0/0 0/0 0; S24 | 2074.9 | T63 |
| 11:45:44.125; 351 | 1253; 170.0/1083.0 | pipelines.mutation/state.exec/55.9; pipelines.mutation/state.run/29.4; pipelines.mutation/state.prepare/24.2; +13 rows | 68.7/7.1 | 1/1 2/3 22; S24 | 1383.9 | T64 |
| 11:45:46.272; 353 | 1160; 367.2/792.8 | scanner.worker/scanner.ipc-frame/259.7; scanner.worker/scanner.ipc-decode/19.0; pipelines.mutation/state.exec/18.1; +13 rows | 273.8/33.4 | 1/1 4/5 995; S24 | 1284.5 | T64 |
| 11:45:48.566; 356 | 1001; 93.0/908.0 | prototype.state/operation/25.8; pipelines.mutation/state.exec/17.2; pipelines.mutation/state.close/4.0; +13 rows | 56.8/4.4 | 3/1 2/3 1034; S24 | 1086.0 | none recorded nearby |
| 11:45:50.862; 357 | 1564; 35.9/1528.1 | seat.panel/operation/16.2; pipelines.controller-schedule/state.write-wait/5.5; registry.read/registry.keyed/4.4; +13 rows | 17.1/5.2 | 3/1 3/3 1672; S24 | 1698.3 | none recorded nearby |
| 11:45:55.006; 358 | 1715; 354.8/1360.2 | registry.write/registry.conversations.all/184.5; registry.write/registry.json/70.8; registry.read/registry.snapshot/33.7; +13 rows | 78.5/34.4 | 2/1 2/2 12; S24 | 1788.6 | none recorded nearby |
| 11:45:57.195; 360 | 1199; 85.7/1113.3 | pipelines.mutation/state.exec/20.4; registry.read/registry.snapshot/15.0; pipelines.mutation/state.close/5.9; +13 rows | 112.4/15.1 | 4/2 2/2 17; S24 | 1297.0 | none recorded nearby |
| 11:46:43.178; 364 | 2254; 551.3/1702.7 | http.render/registry.get/209.2; http.render/registry.json/157.9; registry.read/registry.keyed/43.2; +13 rows | 67.7/7.1 | 1/1 2/2 35; S25 | 2302.1 | none recorded nearby |
| 11:46:49.898; 365 | 1048; 671.7/376.3 | scanner.worker/scanner.ipc-frame/456.4; pipelines.mutation/pipeline.copy/120.9; scanner.worker/scanner.ipc-decode/24.2; +13 rows | 454.9/41.5 | 1/1 1/1 505; S25 | 1096.0 | T65 |
| 11:47:12.330; 366 | 14728; 1345.5/13382.5 | registry.read/registry.keyed/590.0; scanner.worker/scanner.ipc-frame/253.0; registry.read/registry.get/110.4; +13 rows | 296.2/25.7 | 0/0 0/0 0; S25 | 14716.8 | none recorded nearby |
| 11:47:23.028; 368 | 8329; 681.1/7647.9 | registry.read/registry.keyed/314.4; seat.panel/state.all/88.6; seat.panel/operation/58.2; +13 rows | 59.9/12.5 | 11/11 2/2 7943; S25 | 8403.9 | none recorded nearby |
| 11:47:27.393; 371 | 1447; 142.9/1304.1 | registry.read/registry.keyed/31.7; seat.panel/operation/21.2; state.document/operation/18.9; +13 rows | 38.3/1.1 | 45/44 16/16 1234; S25 | 1592.3 | none recorded nearby |
| 11:47:38.215; 372 | 6963; 497.0/6466.0 | registry.read/registry.keyed/302.4; registry.read/registry.get/59.4; registry.read/operation/54.7; +13 rows | 39.8/3.4 | 1/1 14/14 72; S25 | 7099.9 | none recorded nearby |
| 11:48:12.115; 378 | 2201; 468.7/1732.3 | seat-tick.check/state.exec/113.6; seat.panel/state.all/84.4; seat-tick.check/state.prepare/66.0; +13 rows | 144.6/13.1 | 2/1 4/4 2121; S26 | 2285.5 | T68 |
| 11:49:52.294; 384 | 1091; 106.6/984.4 | pipelines.mutation/state.exec/38.6; pipelines.mutation/state.prepare/17.7; pipelines.mutation/state.run/12.1; +13 rows | 54.2/8.8 | 2/1 2/2 12; S27 | 1117.1 | T73 |
| 11:49:59.665; 389 | 1611; 303.8/1307.2 | registry.write/registry.conversations.all/144.0; registry.write/registry.json/59.6; registry.read/registry.snapshot/38.5; +13 rows | 81.2/39.2 | 1/1 18/19 732; S27 | 1692.4 | none recorded nearby |
| 11:50:02.455; 390 | 1814; 342.0/1472.0 | pipelines.mutation/state.exec/106.3; pipelines.controller-schedule/registry.get/96.0; pipelines.controller-schedule/registry.json/62.4; +13 rows | 154.6/93.9 | 1/1 18/19 2708; S27 | 1903.4 | none recorded nearby |
| 11:50:42.427; 396 | 2382; 1081.0/1301.0 | seat-tick.check/state.json/501.9; scanner.worker/scanner.ipc-frame/214.3; seat-tick.check/state.all/193.0; +13 rows | 212.2/7.9 | 0/0 0/0 0; S27 | 2499.1 | T78,T79 |
| 11:50:53.481; 401 | 1437; 11.6/1425.4 | pipelines.controller-job/state.exec/6.3; pipelines.controller-job/state.close/1.6; pipelines.controller-job/state.write-wait/0.8; +13 rows | 9.3/3.7 | 1/1 1/1 7; S28 | 1497.6 | T82,L9 |
| 11:51:07.674; 402 | 1709; 664.5/1044.5 | role-memory.view/state.json/378.6; role-memory.view/state.get/162.1; role-memory.view/memory.view.all/51.3; +13 rows | 53.2/6.1 | 13/13 1/1 2; S28 | 1800.9 | none recorded nearby |
| 11:52:26.126; 407 | 1719; 1403.6/315.4 | registry.read/registry.snapshot/506.2; registry.read/registry.iterate/258.3; registry.read/registry.all/100.0; +13 rows | 1270.3/1244.7 | 0/0 0/0 0; S29 | 1795.7 | none recorded nearby |
| 11:52:27.441; 408 | 1305; 628.9/676.1 | memory.view.iterate/memory.view.iterate/238.1; memory.view.all/memory.view.all/198.5; memory.view.get/memory.view.get/51.7; +13 rows | 45.9/10.9 | 1/1 15/15 100; S29 | 1395.6 | none recorded nearby |
| 11:53:06.830; 413 | 1522; 1359.1/162.9 | registry.read/registry.keyed/720.0; registry.read/registry.all/244.4; runtime.startup/registry.conversations.all/87.7; +13 rows | 88.9/2.4 | 0/0 0/0 0; S29 | 1519.6 | none recorded nearby |
| 11:53:31.080; 414 | 13605; 1006.5/12598.5 | registry.read/registry.keyed/421.5; scanner.worker/scanner.ipc-frame/256.5; registry.read/registry.get/74.7; +13 rows | 195.4/56.0 | 0/0 0/0 0; S30 | 13564.5 | none recorded nearby |
| 11:53:40.783; 416 | 6810; 383.6/6426.4 | registry.read/registry.keyed/240.9; registry.read/registry.get/46.4; registry.read/operation/38.5; +13 rows | 32.0/6.9 | 20/20 2/2 6718; S30 | 6901.9 | none recorded nearby |
| 11:53:47.771; 417 | 5360; 238.4/5121.6 | registry.read/registry.keyed/147.0; registry.read/registry.get/26.5; registry.read/operation/21.0; +13 rows | 24.4/0.8 | 6/6 1/1 5321; S30 | 5403.8 | none recorded nearby |
| 11:53:51.131; 418 | 1886; 1702.6/183.4 | memory.import.curation/operation/604.2; memory.import.curation/memory.view.all/250.9; memory.import.curation/memory.view.iterate/230.0; +13 rows | 68.7/3.3 | 2/1 2/2 1856; S30 | 1945.4 | T87,T88 |
| 11:54:22.468; 420 | 1063; 114.0/949.0 | pipelines.mutation/state.exec/38.7; pipelines.mutation/state.run/19.0; pipelines.mutation/state.prepare/17.8; +13 rows | 49.9/3.8 | 3/1 3/3 20; S30 | 1116.3 | T91 |
| 11:54:31.373; 427 | 1682; 302.0/1380.0 | registry.write/registry.conversations.all/139.0; registry.write/registry.json/60.4; registry.read/registry.snapshot/39.8; +13 rows | 79.7/40.3 | 2/1 2/2 4; S31 | 1761.1 | none recorded nearby |
| 11:54:34.027; 428 | 1458; 205.8/1252.2 | pipelines.controller-schedule/registry.get/77.4; pipelines.controller-schedule/registry.json/52.2; pipelines.mutation/state.exec/15.8; +13 rows | 49.8/11.9 | 3/1 3/3 51; S31 | 1596.8 | none recorded nearby |
| 11:54:37.357; 429 | 1085; 424.4/660.6 | role-memory.view/state.json/237.3; role-memory.view/state.get/114.8; role-memory.view/memory.view.all/23.4; +13 rows | 23.8/3.9 | 3/2 2/2 10; S31 | 1196.0 | T92 |
| 11:55:11.031; 432 | 1455; 27.9/1427.1 | pipelines.controller-job/state.exec/10.1; runtime.startup/runtime.startup.select/10.0; registry.read/registry.keyed/2.3; +13 rows | 25.0/5.5 | 4/1 5/5 49; S31 | 1596.9 | T95,L10 |
| 11:55:32.049; 434 | 1563; 353.7/1209.3 | seat.panel/state.all/136.1; seat.panel/operation/57.9; registry.read/registry.keyed/56.2; +13 rows | 178.3/55.2 | 1/1 1/1 344; S32 | 1541.1 | none recorded nearby |
| 11:55:33.512; 435 | 1454; 416.7/1037.3 | registry.read/registry.snapshot/245.8; registry.read/registry.keyed/44.1; forge.app-connect/state.exec/18.5; +13 rows | 408.7/240.2 | 1/1 1/1 2497; S32 | 1503.8 | none recorded nearby |
| 11:55:37.746; 436 | 4224; 694.5/3529.5 | seat-tick.check/state.exec/260.0; seat-tick.check/state.prepare/116.8; registry.read/registry.snapshot/63.1; +13 rows | 385.7/63.8 | 1/1 2/2 4099; S32 | 4207.9 | T96 |
| 11:55:41.902; 439 | 1008; 665.0/343.0 | registry.read/registry.snapshot/336.8; mcp.project-prefix/state.all/131.4; registry.read/registry.keyed/55.0; +13 rows | 474.0/326.5 | 1/1 4/5 1249; S32 | 1075.6 | none recorded nearby |
| 11:56:06.007; 445 | 2224; 806.5/1417.5 | role-memory.view/state.json/472.6; role-memory.view/state.get/247.8; role-memory.view/memory.view.all/54.8; +13 rows | 30.1/1.0 | 6/2 3/3 21; S32 | 2280.2 | none recorded nearby |
| 11:56:19.824; 450 | 1276; 899.2/376.8 | scanner.worker/scanner.ipc-frame/499.5; seat.panel/state.all/81.6; mcp.page-cursors/memory.view.all/44.0; +13 rows | 514.4/46.5 | 1/1 2/3 532; S32 | 1372.3 | none recorded nearby |
| 11:56:24.470; 453 | 1127; 193.5/933.5 | registry.read/registry.keyed/100.3; prototype.state/operation/10.5; registry.read/registry.get/8.9; +13 rows | 65.4/26.0 | 2/1 5/5 559; S32 | 1162.3 | none recorded nearby |
| 11:56:26.289; 454 | 1810; 375.7/1434.3 | registry.read/registry.keyed/180.7; registry.read/registry.get/23.2; registry.read/registry.all/18.2; +13 rows | 186.2/15.2 | 1/1 5/5 2520; S32 | 1868.9 | none recorded nearby |
| 11:56:29.909; 458 | 1006; 217.2/788.8 | registry.read/registry.keyed/73.1; role-memory.view/memory.view.all/38.4; http.render/state.prepare/14.1; +13 rows | 151.8/24.8 | 3/1 4/4 425; S32 | 1175.1 | T97 |
| 11:56:35.707; 461 | 1086; 279.0/807.0 | done.sweep/state.all/97.5; registry.read/registry.keyed/83.2; done.sweep/state.exec/13.0; +13 rows | 147.8/34.1 | 3/1 3/3 1035; S33 | 1173.2 | none recorded nearby |
| 11:56:44.389; 463 | 1424; 550.3/873.7 | registry.write/registry.conversations.all/271.9; registry.write/registry.json/112.2; registry.read/registry.snapshot/45.3; +13 rows | 104.6/46.8 | 3/1 3/3 62; S33 | 1476.6 | none recorded nearby |
| 11:56:46.220; 464 | 1437; 330.5/1106.5 | registry.read/registry.keyed/85.0; mcp.page-cursors/memory.view.all/55.8; registry.read/registry.snapshot/26.3; +13 rows | 116.1/26.5 | 3/1 3/3 1081; S33 | 1498.5 | T98 |
| 11:56:54.331; 468 | 1933; 126.0/1807.0 | registry.read/registry.keyed/38.8; state.document/operation/9.8; prototype.state/operation/9.3; +13 rows | 128.3/50.6 | 3/1 3/3 427; S33 | 1983.4 | T99 |
| 11:57:05.516; 471 | 2063; 760.5/1302.5 | role-memory.view/state.json/459.9; role-memory.view/state.get/210.0; role-memory.view/memory.view.all/43.5; +13 rows | 45.8/1.6 | 3/1 3/3 51; S33 | 2175.2 | none recorded nearby |
| 11:57:06.565; 472 | 1039; 259.5/779.5 | registry.read/registry.keyed/140.4; files.get/cache.accounting/24.7; prototype.state/operation/10.2; +13 rows | 226.6/37.4 | 3/1 3/3 2577; S33 | 1026.8 | none recorded nearby |
| 11:57:09.354; 473 | 1584; 245.2/1338.8 | state.write-wait/state.exec/50.5; pipelines.controller-checkpoint/state.run/24.4; registry.read/registry.keyed/20.5; +13 rows | 195.0/28.9 | 3/1 3/3 66; S33 | 1676.1 | T101,T102 |
| 11:57:27.434; 480 | 1241; 168.6/1072.4 | memory.view.all/memory.view.all/51.0; registry.read/registry.keyed/39.2; state.document/operation/15.0; +13 rows | 50.6/3.4 | 6/5 16/16 1113; S33 | 1293.1 | none recorded nearby |
| 11:57:54.508; 485 | 1068; 386.8/681.2 | role-memory.view/state.json/235.2; role-memory.view/state.get/116.6; role-memory.view/memory.view.all/25.9; +13 rows | 8.5/0.5 | 14/7 2/2 3; S33 | 1097.0 | none recorded nearby |
| 11:58:02.080; 487 | 1021; 368.3/652.7 | role-memory.view/state.json/219.0; role-memory.view/state.get/113.4; role-memory.view/memory.view.all/25.2; +13 rows | 10.3/1.6 | 28/14 2/2 90; S33 | 1100.8 | none recorded nearby |
| 11:58:31.181; 489 | 1952; 25.3/1926.7 | pipelines.controller-job/state.exec/9.8; registry.read/registry.keyed/3.5; pipelines.controller-job/state.close/3.0; +13 rows | 20.0/7.3 | 0/0 0/0 0; S34 | 2097.0 | T106,L11 |
| 11:59:17.474; 491 | 4364; 955.8/3408.2 | http.render/registry.get/429.8; http.render/registry.json/304.6; registry.read/registry.keyed/64.1; +13 rows | 108.2/8.1 | 0/0 0/0 0; S34 | 4375.5 | none recorded nearby |
| 11:59:57.519; 494 | 1311; 200.9/1110.1 | registry.read/registry.keyed/62.1; memory.view.all/memory.view.all/61.8; state.document/operation/16.7; +13 rows | 71.8/34.4 | 1/1 16/16 1256; S35 | 1402.5 | none recorded nearby |
| 12:00:12.733; 496 | 1361; 139.0/1222.0 | pipelines.mutation/state.exec/44.1; pipelines.mutation/state.prepare/23.3; pipelines.mutation/state.run/15.5; +13 rows | 64.3/5.3 | 1/1 11/11 872; S35 | 1404.2 | T109 |
| 12:00:17.396; 500 | 1893; 183.8/1709.2 | seat-tick.check/state.exec/31.9; pipelines.controller-job/state.tasks.get/26.5; seat-tick.children/state.exec/16.7; +13 rows | 81.9/6.5 | 1/1 10/10 5891; S35 | 1970.3 | T110 |
| 12:00:20.135; 502 | 2069; 142.7/1926.3 | registry.read/registry.snapshot/52.2; registry.read/registry.keyed/15.6; orchestrator.seat-channel/state.exec/14.0; +13 rows | 120.8/60.7 | 5/1 12/12 6439; S35 | 2195.5 | T110,T111 |
| 12:00:26.826; 504 | 1985; 394.5/1590.5 | registry.write/registry.conversations.all/201.1; registry.write/registry.json/78.1; registry.read/registry.snapshot/46.8; +13 rows | 85.2/47.7 | 1/1 1/1 8; S35 | 2099.5 | none recorded nearby |
| 12:00:31.789; 508 | 2225; 395.0/1830.0 | pipelines.controller-schedule/registry.get/113.7; pipelines.controller-schedule/registry.json/85.6; delivery-progress.restore/delivery-progress.restore.slice/69.0; +13 rows | 142.3/69.4 | 3/1 8/8 1117; S35 | 2291.7 | none recorded nearby |
| 12:00:40.174; 510 | 1820; 636.3/1183.7 | role-memory.view/state.json/382.4; role-memory.view/state.get/203.0; role-memory.view/memory.view.all/49.7; +11 rows | 0.4/0.1 | 1/1 1/1 1; S35 | 1904.8 | none recorded nearby |
| 12:00:51.235; 511 | 1403; 228.0/1175.0 | seat-tick.check/state.exec/78.4; seat-tick.check/state.prepare/40.5; seat-tick.check/state.json/19.3; +13 rows | 101.0/5.9 | 0/0 0/0 0; S35 | 1588.0 | T113 |
| 12:01:09.975; 515 | 5589; 1302.5/4286.5 | seat-tick.check/registry.json/454.4; seat-tick.check/registry.all/223.9; seat-tick.check/registry.get/197.5; +13 rows | 1020.9/608.8 | 0/0 0/0 0; S36 | 5568.4 | T114,T115,T116,T117 |
| 12:01:12.658; 517 | 1519; 104.0/1415.0 | agent.deferred-spawn/state.write-wait/17.0; memory.curation-status/memory.view.all/12.7; pipelines.controller-checkpoint/state.run/11.5; +13 rows | 71.9/17.3 | 2/1 2/3 1840; S36 | 1597.9 | none recorded nearby |
| 12:01:17.134; 518 | 1307; 1291.0/16.0 | memory.engine-start/state.write-wait/1277.9; registry.read/registry.keyed/3.2; recorded-check.observe/state.write-wait/2.1; +13 rows | 1287.1/1278.1 | 1/1 1/1 1318; S36 | 1401.1 | none recorded nearby |
| 12:01:28.488; 521 | 1550; 293.7/1256.3 | agent.deferred-spawn/registry.get/147.0; agent.deferred-spawn/registry.json/100.5; agent.deferred-spawn/registry.prepare/17.8; +13 rows | 76.2/3.4 | 1/1 1/1 174; S36 | 1604.5 | none recorded nearby |
| 12:01:51.292; 525 | 1080; 114.0/966.0 | pipelines.mutation/state.exec/39.5; pipelines.mutation/state.prepare/18.5; pipelines.mutation/state.run/18.4; +13 rows | 44.5/2.8 | 1/1 1/1 31; S36 | 1122.9 | T118 |
| 12:01:57.593; 528 | 1628; 315.1/1312.9 | registry.write/registry.conversations.all/159.6; registry.write/registry.json/59.7; registry.read/registry.snapshot/37.4; +13 rows | 74.9/38.1 | 0/0 0/0 0; S36 | 1692.7 | none recorded nearby |
| 12:02:19.242; 530 | 3208; 2741.1/466.9 | memory.import.curation/operation/854.4; registry.read/registry.snapshot/480.0; memory.import.curation/memory.view.all/243.0; +13 rows | 593.2/488.1 | 0/0 1/1 0; S37 | 3244.5 | T119,T120,L12,L13 |
| 12:02:26.824; 534 | 2246; 1853.8/392.2 | registry.read/registry.snapshot/704.2; registry.read/registry.iterate/329.3; registry.read/registry.all/131.4; +13 rows | 1685.6/1669.8 | 1/1 0/1 1995; S37 | 2395.5 | none recorded nearby |
| 12:02:27.948; 535 | 1113; 397.2/715.8 | memory.view.all/memory.view.all/94.6; seat-tick.prepare/state.json/57.9; memory.view.iterate/memory.view.iterate/52.8; +13 rows | 52.3/13.1 | 1/1 15/15 108; S37 | 1197.0 | none recorded nearby |
| 12:02:50.352; 538 | 1341; 10.6/1330.4 | pipelines.controller-job/state.exec/6.5; pipelines.controller-job/state.close/1.1; pipelines.controller-job/state.write-wait/0.6; +13 rows | 9.1/3.7 | 0/0 0/0 0; S37 | 1495.8 | T124,L14 |
| 12:03:04.570; 542 | 1568; 1387.8/180.2 | registry.read/registry.keyed/725.4; registry.read/registry.all/255.6; runtime.startup/registry.conversations.all/86.0; +13 rows | 91.4/2.8 | 12/6 2/2 21; S37 | 1695.8 | none recorded nearby |
| 12:03:07.313; 543 | 1331; 511.3/819.7 | role-memory.view/state.json/320.4; role-memory.view/state.get/140.5; role-memory.view/memory.view.all/24.8; +13 rows | 15.4/4.1 | 24/12 2/2 10; S37 | 1391.1 | none recorded nearby |
| 12:03:36.799; 544 | 13502; 1077.0/12425.0 | registry.read/registry.keyed/426.1; registry.read/registry.snapshot/176.7; seat.panel/state.all/114.2; +13 rows | 224.8/184.3 | 0/0 0/0 0; S38 | 13475.9 | none recorded nearby |
| 12:03:46.692; 546 | 6284; 343.6/5940.4 | registry.read/registry.keyed/181.7; seat.panel/operation/45.4; registry.read/registry.get/33.2; +13 rows | 34.8/1.6 | 5/5 1/1 6146; S38 | 6400.8 | none recorded nearby |
| 12:03:53.224; 547 | 5625; 295.6/5329.4 | registry.read/registry.keyed/155.2; registry.read/registry.get/31.8; seat.panel/operation/29.2; +13 rows | 20.7/1.9 | 9/9 1/1 5500; S38 | 5800.1 | none recorded nearby |
| 12:04:19.412; 548 | 1012; 111.4/900.6 | pipelines.mutation/state.exec/39.4; pipelines.mutation/state.run/18.2; pipelines.mutation/state.prepare/16.7; +13 rows | 46.7/3.7 | 2/1 3/3 303; S38 | 1018.0 | T127 |
| 12:04:27.303; 551 | 4219; 4044.0/175.0 | memory.import.curation/operation/1696.9; memory.import.curation/state.run/622.2; memory.import.curation/state.json/389.6; +13 rows | 61.2/4.9 | 8/4 2/2 4189; S39 | 4238.6 | T128,T129,L15,L16 |
| 12:04:30.615; 553 | 1587; 250.3/1336.7 | registry.read/registry.snapshot/46.9; registry.read/registry.keyed/40.4; pipelines.mutation/state.exec/22.4; +13 rows | 115.3/47.4 | 31/31 1/1 813; S39 | 1688.7 | T130 |
| 12:05:21.487; 562 | 1362; 1203.6/158.4 | memory.import.curation/operation/562.3; memory.import.curation/memory.view.all/115.5; registry.read/registry.keyed/79.1; +13 rows | 77.9/17.4 | 0/0 0/0 0; S39 | 1489.3 | T133,T134 |
| 12:05:44.842; 565 | 1299; 523.6/775.4 | role-memory.view/state.json/359.6; role-memory.view/state.get/136.9; role-memory.view/memory.view.all/25.7; +10 rows | 0.9/0.5 | 1/1 2/2 5; S40 | 1393.2 | none recorded nearby |
| 12:06:28.190; 570 | 1646; 1477.3/168.7 | memory.import.curation/operation/506.9; memory.import.curation/memory.view.all/244.9; memory.import.curation/memory.view.iterate/217.6; +13 rows | 82.7/25.3 | 0/0 0/0 0; S40 | 1739.1 | T161,T162 |
| 12:06:59.244; 571 | 1183; 413.8/769.2 | role-memory.view/state.json/247.0; role-memory.view/state.get/133.9; role-memory.view/memory.view.all/30.2; +13 rows | 1.2/0.4 | 14/14 1/1 3; S41 | 1302.0 | none recorded nearby |
| 12:07:08.684; 572 | 1390; 160.2/1229.8 | pipelines.mutation/state.exec/47.3; pipelines.mutation/state.run/29.1; pipelines.mutation/state.prepare/22.0; +13 rows | 61.8/3.9 | 1/1 1/1 59; S41 | 1408.9 | T165 |
| 12:07:14.132; 576 | 1749; 232.9/1516.1 | scanner.worker/scanner.ipc-frame/139.4; registry.read/registry.keyed/14.5; scanner.worker/scanner.ipc-decode/12.7; +13 rows | 186.2/23.4 | 3/2 2/2 1422; S41 | 1798.2 | none recorded nearby |
| 12:07:20.067; 578 | 1587; 287.9/1299.1 | registry.write/registry.conversations.all/130.7; registry.write/registry.json/66.8; registry.read/registry.snapshot/31.3; +13 rows | 66.7/31.9 | 0/0 0/0 0; S41 | 1694.0 | none recorded nearby |
| 12:07:21.897; 579 | 1039; 65.6/973.4 | pipelines.mutation/state.exec/19.7; registry.read/registry.snapshot/11.7; pipelines.mutation/state.close/3.5; +13 rows | 88.0/11.8 | 0/0 0/0 0; S41 | 1195.6 | none recorded nearby |
| 12:07:26.351; 580 | 1741; 1444.4/296.6 | registry.read/registry.snapshot/541.9; registry.read/registry.iterate/260.9; registry.read/registry.all/96.0; +13 rows | 1329.9/1299.4 | 0/0 0/0 0; S41 | 1776.3 | none recorded nearby |
| 12:08:07.330; 585 | 1076; 210.8/865.2 | pipelines.controller-schedule/registry.get/105.8; pipelines.controller-schedule/registry.json/85.3; pipelines.controller-schedule/registry.prepare/10.4; +13 rows | 760.3/1.4 | 0/0 0/0 0; S41 | 1003.5 | none recorded nearby |
| 12:08:47.763; 589 | 1003; 150.4/852.6 | pipelines.mutation/state.run/46.9; pipelines.mutation/state.exec/36.9; pipelines.mutation/state.prepare/18.0; +13 rows | 46.8/3.6 | 71/71 1/1 0; S41 | 1093.6 | T171 |
| 12:08:59.466; 592 | 1336; 20.0/1316.0 | registry.read/registry.keyed/3.7; pipelines.controller-schedule/state.write-wait/3.6; pipelines.controller-schedule/state.exec/2.8; +13 rows | 16.8/3.3 | 1/1 1/1 10; S42 | 1397.3 | none recorded nearby |
| 12:09:03.166; 593 | 1577; 304.9/1272.1 | registry.write/registry.conversations.all/135.8; registry.write/registry.json/56.6; registry.read/registry.snapshot/39.0; +13 rows | 75.8/39.6 | 1/1 1/1 14; S42 | 1691.2 | none recorded nearby |
| 12:12:38.865; 607 | 2866; 1036.8/1829.2 | http.render/state.json/360.9; http.render/state.run/123.5; http.render/state.all/122.8; +13 rows | 185.1/105.6 | 4/1 5/5 2795; S43 | 2882.9 | T180,T181,L17 |
| 12:12:58.169; 610 | 3315; 1295.6/2019.4 | seat-tick.check/state.json/655.9; seat-tick.check/state.all/291.4; seat-tick.check/state.get/76.2; +13 rows | 36.8/10.9 | 3/3 1/2 3290; S43 | 3403.3 | T183,T184 |
| 12:13:08.353; 613 | 2788; 732.4/2055.6 | agent.deferred-spawn/registry.get/266.7; agent.deferred-spawn/registry.json/172.7; registry.read/registry.snapshot/163.5; +13 rows | 264.0/175.0 | 1/1 1/1 39; S43 | 2898.3 | none recorded nearby |
| 12:13:48.446; 618 | 1159; 18.2/1140.8 | prototype.state/operation/5.8; delivery-progress.restore/delivery-progress.restore.slice/4.7; prototype.state/state.json/1.5; +13 rows | 9.4/8.1 | 1/1 1/1 1; S44 | 1300.4 | none recorded nearby |
| 12:14:28.737; 621 | 1246; 137.0/1109.0 | pipelines.mutation/state.exec/40.2; pipelines.mutation/state.run/24.5; pipelines.mutation/state.prepare/21.1; +13 rows | 56.7/4.3 | 0/0 0/0 0; S44 | 1309.6 | T188 |
| 12:14:34.421; 626 | 1711; 130.0/1581.0 | seat.panel/state.all/69.6; seat.panel/operation/21.7; orchestrator.seat-channel/state.exec/10.3; +13 rows | 23.8/5.2 | 2/1 2/2 1900; S44 | 1797.3 | none recorded nearby |
| 12:14:39.209; 628 | 2100; 404.4/1695.6 | registry.write/registry.conversations.all/177.8; registry.write/registry.json/83.6; registry.read/registry.snapshot/64.5; +13 rows | 111.4/65.5 | 9/9 1/1 5; S44 | 2292.6 | none recorded nearby |
| 12:14:41.354; 630 | 1097; 94.3/1002.7 | pipelines.mutation/state.exec/20.1; registry.read/registry.snapshot/14.9; registry.read/registry.keyed/5.0; +13 rows | 114.6/14.9 | 1/1 1/1 105; S44 | 1199.3 | none recorded nearby |
| 12:14:58.475; 633 | 1583; 1000.1/582.9 | memory.view.iterate/memory.view.iterate/429.0; memory.view.all/memory.view.all/343.7; memory.view.get/memory.view.get/96.3; +13 rows | 14.8/0.6 | 0/0 15/15 0; S45 | 1552.5 | none recorded nearby |
| 12:15:06.940; 634 | 2612; 2372.0/240.0 | memory.import.curation/operation/916.5; state.document/operation/274.8; memory.import.curation/memory.view.all/176.8; +13 rows | 101.4/18.1 | 2/1 2/2 2593; S45 | 2686.5 | T189,T190,L19,L20 |
| 12:15:09.821; 635 | 1033; 544.9/488.1 | state.document/operation/146.1; orchestrator.seat-channel/state.write-wait/71.9; seat-tick.check/operation/70.6; +13 rows | 146.4/75.0 | 1/1 10/10 771; S45 | 1086.0 | T191 |
| 12:15:26.694; 638 | 1044; 98.9/945.1 | seat-tick.check/state.exec/23.0; orchestrator.seat-channel/state.exec/12.9; seat-tick.check/state.prepare/10.9; +13 rows | 46.6/5.5 | 0/0 0/0 0; S45 | 1095.1 | T192,T193 |
| 12:15:35.806; 641 | 1369; 105.5/1263.5 | seat-tick.check/state.exec/30.6; state.document/operation/17.6; state.document/state.exec/11.8; +13 rows | 67.9/7.7 | 4/4 1/1 1328; S45 | 1387.4 | T194 |
| 12:15:38.348; 642 | 1278; 304.3/973.7 | seat-tick.check/state.exec/99.8; seat-tick.check/state.prepare/71.4; seat-tick.check/state.close/33.0; +13 rows | 128.1/7.7 | 4/4 1/1 1255; S45 | 1388.5 | none recorded nearby |
| 12:17:23.006; 645 | 2116; 413.8/1702.2 | http.render/state.json/116.8; http.render/state.run/60.1; http.render/memory.view.all/56.5; +13 rows | 73.9/5.5 | 2/2 1/1 2019; S46 | 2292.5 | T198,T199,L21 |
| 12:18:26.925; 652 | 1078; 132.1/945.9 | pipelines.mutation/state.exec/40.2; pipelines.mutation/state.run/30.5; pipelines.mutation/state.prepare/17.9; +13 rows | 53.5/4.3 | 0/0 0/0 0; S47 | 1082.9 | T206 |
| 12:18:31.049; 655 | 1360; 44.8/1315.2 | registry.read/registry.snapshot/13.8; activity.task-spend.read/operation/6.5; pipelines.controller-schedule/state.write-wait/5.2; +13 rows | 27.7/18.8 | 1/1 1/1 9; S47 | 1497.6 | none recorded nearby |
| 12:18:32.947; 656 | 1047; 115.1/931.9 | pipelines.mutation/state.exec/35.7; pipelines.mutation/state.run/22.0; pipelines.mutation/state.prepare/19.1; +13 rows | 47.2/4.0 | 0/0 0/0 0; S47 | 987.0 | T207 |
| 12:18:36.794; 660 | 1141; 168.5/972.5 | pipelines.mutation/state.write-wait/38.2; pipelines.controller-schedule/state.json/34.7; telegram.outbound-state/state.write-wait/23.3; +13 rows | 105.1/40.0 | 1/1 2/2 1839; S47 | 845.3 | none recorded nearby |
| 12:18:38.530; 661 | 1284; 18.1/1265.9 | pipelines.controller-schedule/state.write-wait/4.1; pipelines.controller-schedule/state.exec/3.4; delivery-progress.restore/delivery-progress.restore.slice/2.9; +13 rows | 15.8/5.5 | 2/1 3/3 1290; S47 | 1399.5 | none recorded nearby |
| 12:18:40.110; 662 | 1500; 286.8/1213.2 | registry.write/registry.conversations.all/134.4; registry.write/registry.json/62.2; registry.read/registry.snapshot/33.9; +13 rows | 67.5/34.5 | 3/1 3/3 11; S47 | 1593.5 | none recorded nearby |
| 12:18:42.196; 663 | 1620; 228.3/1391.7 | pipelines.controller-schedule/registry.get/93.6; pipelines.controller-schedule/registry.json/57.6; pipelines.mutation/state.exec/16.0; +13 rows | 53.1/10.5 | 3/2 2/2 12; S47 | 1699.4 | none recorded nearby |
| 12:18:46.238; 665 | 1578; 285.8/1292.2 | registry.write/registry.conversations.all/131.2; registry.write/registry.json/56.4; registry.read/registry.snapshot/42.4; +13 rows | 77.8/43.0 | 4/4 1/1 37; S47 | 1697.6 | none recorded nearby |
| 12:19:27.619; 671 | 1387; 58.4/1328.6 | registry.read/registry.keyed/27.5; activity.task-spend.read/operation/11.9; pipelines.controller-schedule/state.write-wait/3.9; +13 rows | 39.4/18.9 | 4/3 2/2 1331; S48 | 1494.2 | none recorded nearby |
| 12:19:30.647; 672 | 1669; 311.7/1357.3 | registry.write/registry.conversations.all/144.6; registry.write/registry.json/58.9; registry.read/registry.snapshot/35.9; +13 rows | 80.1/36.4 | 0/0 0/0 0; S48 | 1791.4 | none recorded nearby |
| 12:19:42.935; 674 | 1661; 411.5/1249.5 | http.render/registry.get/184.4; http.render/registry.json/146.1; registry.read/registry.keyed/27.2; +13 rows | 51.2/3.3 | 0/0 0/0 0; S48 | 1665.6 | none recorded nearby |
| 12:20:20.156; 680 | 1120; 303.8/816.2 | seat-tick.check/state.exec/94.2; seat-tick.check/state.prepare/47.2; seat-tick.check/state.json/23.1; +13 rows | 150.0/13.7 | 7/7 1/1 951; S48 | 1181.0 | none recorded nearby |
| 12:20:22.092; 681 | 1359; 147.6/1211.4 | pipelines.mutation/state.exec/48.2; pipelines.mutation/state.prepare/25.9; pipelines.mutation/state.run/17.4; +13 rows | 59.0/4.5 | 17/16 1/2 9; S48 | 1487.5 | none recorded nearby |
| 12:20:23.208; 682 | 1100; 443.5/656.5 | pipelines.controller-schedule/pipeline.copy/166.0; registry.read/registry.snapshot/68.8; memory.curation-status/memory.view.all/38.2; +13 rows | 227.5/69.8 | 2/1 1/2 1572; S48 | 1174.4 | T212 |
| 12:20:26.820; 686 | 1185; 72.6/1112.4 | pipelines.mutation/state.exec/22.3; memory.curation-status/memory.view.all/8.3; orchestrator.seat-channel/state.exec/6.9; +13 rows | 46.7/4.4 | 3/1 2/3 1141; S48 | 1295.6 | none recorded nearby |
| 12:20:29.343; 688 | 1867; 125.5/1741.5 | http.render/state.all/57.5; seat.panel/operation/17.4; registry.read/registry.snapshot/10.9; +13 rows | 39.5/14.9 | 3/1 3/3 1491; S49 | 1980.3 | none recorded nearby |
| 12:20:33.841; 689 | 1734; 353.5/1380.5 | registry.write/registry.conversations.all/176.5; registry.write/registry.json/73.3; registry.read/registry.snapshot/32.9; +13 rows | 78.4/33.4 | 8/8 1/1 1; S49 | 1879.6 | T213 |
| 12:20:36.912; 691 | 2097; 279.7/1817.3 | pipelines.controller-schedule/registry.get/107.7; pipelines.controller-schedule/registry.json/72.6; pipelines.mutation/state.exec/17.7; +13 rows | 66.7/14.2 | 3/3 1/1 25; S49 | 2194.6 | none recorded nearby |
| 12:20:57.556; 692 | 1545; 1243.0/302.0 | memory.import.curation/operation/425.1; state.document/operation/250.2; registry.read/registry.keyed/82.1; +13 rows | 100.5/17.9 | 3/3 1/1 1494; S49 | 1696.6 | T214 |
| 12:22:03.397; 694 | 3210; 940.6/2269.4 | http.render/state.run/286.8; http.render/state.json/225.2; http.render/state.exec/129.0; +13 rows | 133.7/79.7 | 0/0 0/0 0; S50 | 3217.0 | T216,T217,L22,L23 |
| 12:22:28.700; 696 | 1600; 1015.9/584.1 | memory.view.all/memory.view.all/399.5; memory.view.iterate/memory.view.iterate/308.8; seat-tick.prepare/state.json/91.1; +13 rows | 25.0/0.5 | 1/1 15/15 2; S50 | 1609.4 | none recorded nearby |
| 12:22:45.267; 702 | 1052; 238.3/813.7 | http.render/registry.get/118.8; http.render/registry.json/86.0; http.render/registry.prepare/13.8; +13 rows | 350.9/9.7 | 2/1 5/5 640; S50 | 1199.5 | none recorded nearby |
| 12:23:23.498; 709 | 5125; 2199.8/2925.2 | seat-tick.check/state.json/1052.3; seat-tick.check/state.all/408.8; memory.curation-status/memory.view.all/260.0; +13 rows | 28.5/3.1 | 0/0 0/0 0; S51 | 5252.2 | none recorded nearby |
| 12:23:28.816; 710 | 2654; 694.8/1959.2 | scanner.worker/scanner.ipc-frame/267.7; http.render/state.run/65.6; http.render/memory.view.all/61.8; +13 rows | 322.3/33.3 | 5/5 1/1 2258; S51 | 2774.7 | T222,T223,L24 |
| 12:24:48.703; 712 | 1843; 441.7/1401.3 | http.render/registry.get/189.7; http.render/registry.json/147.5; registry.read/registry.keyed/28.0; +13 rows | 50.1/2.5 | 0/0 0/0 0; S52 | 1816.5 | none recorded nearby |
| 12:24:58.095; 714 | 1003; 312.1/690.9 | memory.view.all/memory.view.all/124.0; memory.view.get/memory.view.get/53.5; seat-tick.prepare/state.json/31.8; +13 rows | 19.6/0.6 | 181/180 16/16 940; S52 | 1101.5 | none recorded nearby |
| 12:25:10.163; 715 | 1332; 210.1/1121.9 | pipelines.mutation/state.exec/41.0; pipelines.mutation/state.run/26.0; pipelines.mutation/state.prepare/19.3; +13 rows | 102.2/17.7 | 3/1 3/3 83; S52 | 1301.0 | T225 |
| 12:25:13.341; 718 | 1059; 179.1/879.9 | registry.read/registry.snapshot/43.4; seat-tick.check/state.exec/25.4; seat-tick.children/state.exec/25.4; +13 rows | 118.2/44.0 | 3/1 5/5 2888; S52 | 1095.0 | T226,T227 |
| 12:25:14.779; 719 | 1429; 171.1/1257.9 | seat-tick.check/state.exec/22.0; telegram.outbound-state/state.write-wait/19.4; seat-tick.children/state.exec/14.2; +13 rows | 102.5/19.8 | 1/1 6/6 3790; S52 | 1584.1 | T226,T227 |
| 12:25:16.493; 720 | 1703; 182.6/1520.4 | seat-tick.check/state.exec/24.8; registry.read/registry.snapshot/20.2; pipelines.mutation/state.exec/17.3; +13 rows | 118.3/20.2 | 1/1 7/7 4498; S52 | 1783.4 | T227 |
| 12:25:19.067; 721 | 1804; 136.0/1668.0 | seat-tick.children/state.exec/21.8; seat-tick.children/state.prepare/16.8; registry.read/registry.keyed/16.2; +13 rows | 84.4/18.4 | 1/1 9/9 2093; S52 | 1895.5 | none recorded nearby |
| 12:25:25.116; 722 | 1848; 345.9/1502.1 | registry.write/registry.conversations.all/178.6; registry.write/registry.json/69.6; registry.read/registry.snapshot/34.7; +13 rows | 70.6/35.1 | 2/2 1/1 19; S52 | 1999.3 | none recorded nearby |
| 12:25:28.267; 725 | 1813; 289.5/1523.5 | pipelines.controller-schedule/registry.get/96.7; pipelines.controller-schedule/registry.json/74.8; registry.read/registry.snapshot/23.1; +13 rows | 217.6/28.0 | 2/1 3/3 91; S52 | 1895.3 | none recorded nearby |
| 12:25:36.009; 728 | 1150; 88.0/1062.0 | seat-tick.check/state.exec/23.3; state.document/operation/16.4; state.document/state.exec/11.0; +13 rows | 58.5/6.7 | 0/0 0/0 0; S52 | 1165.9 | T229 |
| 12:25:41.775; 729 | 3273; 946.4/2326.6 | http.render/state.run/287.2; http.render/state.json/235.5; http.render/state.exec/153.8; +13 rows | 56.1/11.2 | 0/0 0/0 0; S52 | 3239.3 | T230,T231,L25,L26 |
| 12:25:50.193; 731 | 2749; 2498.4/250.6 | memory.import.curation/operation/766.9; memory.import.curation/memory.view.all/445.7; state.document/operation/248.4; +13 rows | 82.2/13.7 | 1/1 0/1 2649; S53 | 2769.8 | T232,T233,L27,L28 |
| 12:25:57.201; 733 | 3355; 1295.3/2059.7 | seat-tick.check/state.json/694.6; seat-tick.check/state.all/290.8; memory.curation-status/memory.view.all/81.6; +13 rows | 44.0/2.8 | 0/0 0/0 0; S53 | 3500.7 | none recorded nearby |
| 12:26:17.306; 736 | 1611; 75.1/1535.9 | pipelines.controller-job/state.json/38.3; pipelines.controller-job/state.all/18.6; pipelines.controller-job/state.exec/12.1; +13 rows | 17.3/5.0 | 0/0 0/0 0; S53 | 1684.3 | T236,L29 |
| 12:26:32.064; 741 | 5473; 4146.1/1326.9 | memory.import.curation/operation/2173.6; memory.import.curation/state.json/600.3; memory.import.curation/state.get/333.6; +13 rows | 158.5/21.6 | 0/0 0/0 0; S53 | 5347.7 | T238,T239,L30,L31 |
| 12:26:47.096; 748 | 1166; 588.3/577.7 | registry.read/registry.keyed/271.0; state.document/operation/88.4; mcp.page-cursors/liveness.snapshot/48.2; +13 rows | 407.4/207.8 | 1/1 1/1 572; S53 | 915.9 | none recorded nearby |
| 12:27:09.990; 753 | 3737; 293.0/3444.0 | http.render/state.json/114.4; registry.read/registry.keyed/59.3; http.render/state.all/37.8; +13 rows | 91.0/32.6 | 1/1 1/1 3546; S54 | 3812.1 | none recorded nearby |
| 12:27:19.498; 754 | 3721; 238.4/3482.6 | seat.panel/state.all/101.9; seat.panel/operation/49.5; state.document/state.exec/23.1; +13 rows | 43.3/14.0 | 1/1 1/1 3313; S54 | 3736.8 | none recorded nearby |
| 12:27:29.477; 755 | 5359; 1904.5/3454.5 | hosts.retirement/operation/1222.5; registry.read/registry.keyed/146.3; hosts.retirement/registry.json/133.0; +13 rows | 188.2/43.2 | 2/1 2/3 5435; S54 | 5401.2 | none recorded nearby |
| 12:27:31.829; 756 | 2342; 797.2/1544.8 | memory.view.all/memory.view.all/268.6; memory.view.iterate/memory.view.iterate/150.7; memory.view.get/memory.view.get/111.3; +13 rows | 113.0/36.1 | 3/1 18/19 7673; S54 | 2346.9 | none recorded nearby |
| 12:27:38.782; 759 | 5445; 4440.6/1004.4 | registry.read/registry.snapshot/1819.9; registry.read/registry.iterate/776.2; registry.read/registry.all/273.3; +13 rows | 4084.6/4028.5 | 1/1 19/19 6773; S54 | 5419.1 | none recorded nearby |
| 12:27:44.416; 760 | 3637; 79.7/3557.3 | registry.read/registry.snapshot/49.8; http.render/state.json/5.9; registry.read/registry.keyed/4.3; +13 rows | 68.9/50.6 | 4/1 17/18 11870; S54 | 3762.4 | none recorded nearby |
| 12:27:54.186; 762 | 4055; 517.9/3537.1 | registry.read/registry.snapshot/424.4; orchestrator.seat-channel/state.exec/24.8; registry.read/registry.deliveryOperationOwners.iterate/10.2; +13 rows | 489.5/436.4 | 5/1 5/5 4112; S54 | 4166.5 | none recorded nearby |
| 12:28:09.489; 767 | 3550; 98.2/3451.8 | registry.read/registry.keyed/30.0; seat-tick.check/seat-tick.project/12.0; http.render/state.json/6.3; +13 rows | 72.6/14.5 | 2/1 10/11 5990; S55 | 3581.3 | none recorded nearby |
| 12:28:18.668; 768 | 3141; 26.0/3115.0 | mcp.receipts/mcp-receipts.exec/5.7; http.render/state.json/4.6; mcp.receipts/mcp-receipts.run/3.1; +13 rows | 16.0/13.0 | 6/2 11/12 3483; S55 | 3290.8 | none recorded nearby |
| 12:28:22.359; 769 | 2019; 165.7/1853.3 | seat-tick.check/state.exec/77.4; seat-tick.check/state.prepare/29.6; seat-tick.check/state.close/22.5; +13 rows | 103.7/9.5 | 2/1 14/14 2811; S55 | 2047.7 | T242,T243 |
| 12:28:26.890; 770 | 2798; 79.8/2718.2 | memory.curation-panel/memory.view.all/50.5; http.render/state.json/4.3; mcp.receipts/state.write-wait/3.7; +13 rows | 14.3/9.4 | 6/2 12/13 2880; S55 | 2896.5 | none recorded nearby |
| 12:28:35.456; 771 | 3014; 18.7/2995.3 | http.render/state.json/4.2; mcp.receipts/state.write-wait/3.3; mcp.receipts/mcp-receipts.run/3.1; +13 rows | 10.6/9.6 | 10/2 9/10 70; S55 | 3105.6 | none recorded nearby |
| 12:28:45.785; 775 | 3702; 152.1/3549.9 | role-memory.view/memory.view.iterate/53.8; memory.curation-panel/memory.view.all/33.1; mcp.receipts/mcp-receipts.exec/16.6; +13 rows | 105.9/53.9 | 4/1 11/11 3810; S55 | 3753.8 | none recorded nearby |
| 12:28:54.269; 777 | 2818; 66.6/2751.4 | memory.curation-panel/memory.view.all/24.8; http.render/state.json/6.0; controller.account-credit-guard/operation/4.9; +13 rows | 19.2/8.9 | 2/1 8/8 3185; S55 | 2862.2 | none recorded nearby |
| 12:29:02.209; 779 | 3243; 401.1/2841.9 | role-memory.view/memory.view.all/168.8; role-memory.view/state.json/147.9; role-memory.view/state.get/58.7; +13 rows | 16.9/6.8 | 8/3 5/7 149; S55 | 3397.9 | none recorded nearby |
| 12:29:09.165; 782 | 2396; 100.9/2295.1 | http.render/memory.view.all/75.0; state.document/operation/6.4; http.render/state.json/3.7; +13 rows | 9.0/6.9 | 1/1 5/6 481; S56 | 2501.9 | none recorded nearby |
| 12:29:14.891; 784 | 2041; 39.8/2001.2 | mcp.receipts/mcp-receipts.exec/5.8; state.document/operation/5.6; delivery-progress.restore/delivery-progress.restore.slice/4.2; +13 rows | 23.2/11.8 | 5/2 4/5 11; S56 | 2201.7 | none recorded nearby |
| 12:29:20.931; 785 | 2684; 51.2/2632.8 | state.document/operation/8.2; registry.read/registry.keyed/6.2; memory.curation-panel/operation/5.9; +13 rows | 20.4/9.2 | 4/1 4/4 2674; S56 | 2801.5 | none recorded nearby |
| 12:29:25.356; 786 | 2090; 48.3/2041.7 | mcp.receipts/mcp-receipts.exec/11.8; registry.read/registry.keyed/8.2; state.document/operation/5.6; +13 rows | 31.0/16.7 | 4/1 4/4 2071; S56 | 2196.8 | none recorded nearby |
| 12:29:28.238; 787 | 1849; 77.1/1771.9 | prototype.state/state.json/23.4; memory.curation-panel/memory.view.all/11.6; prototype.state/operation/6.5; +13 rows | 12.6/4.9 | 4/1 4/4 1819; S56 | 1989.9 | none recorded nearby |
| 12:29:31.861; 788 | 1828; 44.9/1783.1 | state.document/operation/7.0; role-memory.view/memory.view.iterate/6.5; memory.curation-panel/memory.view.all/6.0; +13 rows | 19.8/6.6 | 7/2 4/4 1822; S56 | 2000.7 | none recorded nearby |
| 12:29:35.280; 789 | 2065; 44.7/2020.3 | memory.curation-panel/memory.view.all/6.6; registry.read/registry.keyed/4.8; state.document/operation/4.8; +13 rows | 20.1/6.6 | 7/2 5/6 2062; S56 | 2201.6 | none recorded nearby |
| 12:29:38.916; 790 | 2196; 41.3/2154.7 | state.document/operation/6.5; http.render/state.json/4.7; memory.curation-panel/operation/4.6; +13 rows | 16.1/6.0 | 8/2 4/4 2173; S56 | 2298.9 | none recorded nearby |
| 12:29:41.792; 791 | 1997; 55.2/1941.8 | orchestrator.seat-channel/state.exec/9.2; state.document/operation/6.6; orchestrator.seat-channel/state.prepare/5.0; +13 rows | 23.5/5.2 | 4/1 4/4 1947; S56 | 2100.4 | none recorded nearby |
| 12:29:46.547; 793 | 2254; 45.7/2208.3 | state.document/operation/7.4; mcp.receipts/mcp-receipts.exec/6.6; delivery-progress.restore/delivery-progress.restore.slice/4.7; +13 rows | 23.3/13.0 | 6/2 5/6 24; S56 | 2302.2 | none recorded nearby |
| 12:29:53.415; 796 | 2962; 132.7/2829.3 | http.render/memory.view.all/90.2; registry.read/registry.keyed/5.0; state.document/operation/4.9; +13 rows | 23.3/8.4 | 9/3 4/5 2928; S56 | 3100.8 | none recorded nearby |
| 12:29:58.936; 797 | 2889; 423.8/2465.2 | scanner.worker/scanner.ipc-frame/360.3; scanner.worker/scanner.ipc-decode/27.5; http.render/state.json/10.0; +13 rows | 363.7/43.0 | 3/1 3/3 2461; S56 | 3000.5 | none recorded nearby |
| 12:30:00.833; 798 | 1158; 94.6/1063.4 | registry.read/registry.keyed/18.4; memory.curation-panel/memory.view.all/11.2; state.document/operation/10.7; +13 rows | 37.6/7.7 | 5/1 19/20 987; S56 | 1298.9 | none recorded nearby |
| 12:30:12.201; 799 | 10526; 3296.2/7229.8 | http.render/registry.json/1537.7; http.render/registry.get/1498.6; http.render/registry.prepare/137.8; +13 rows | 74.0/12.0 | 1/1 20/20 1062; S57 | 10594.9 | T244 |
| 12:30:14.121; 801 | 1123; 517.2/605.8 | http.render/pipeline.copy/193.9; pipelines.mutation/pipeline.copy/105.7; registry.read/registry.keyed/57.7; +13 rows | 159.7/20.7 | 1/1 21/21 13434; S57 | 1284.5 | T244,T245 |
| 12:30:18.029; 802 | 3298; 2727.0/571.0 | memory.import.curation/operation/1470.8; memory.import.curation/state.json/387.8; memory.import.curation/state.get/229.9; +13 rows | 83.0/4.9 | 1/1 23/23 17136; S57 | 3396.6 | T245,T246,L34,L35 |
| 12:30:20.027; 803 | 1677; 17.7/1659.3 | registry.read/registry.keyed/3.6; http.render/state.json/2.7; mcp.receipts/state.write-wait/1.6; +13 rows | 12.5/5.0 | 4/1 20/21 18914; S57 | 1798.5 | T246,L34,L35 |
| 12:30:25.164; 804 | 2254; 49.6/2204.4 | memory.curation-panel/operation/20.1; memory.curation-panel/memory.view.all/6.9; state.document/operation/4.9; +13 rows | 10.1/7.5 | 5/2 5/7 122; S57 | 2399.0 | none recorded nearby |
| 12:30:29.633; 805 | 3514; 895.5/2618.5 | http.render/state.run/302.7; http.render/state.json/235.6; http.render/memory.view.all/81.5; +13 rows | 62.2/9.9 | 2/1 17/17 187; S57 | 3581.3 | T247,T248,L36,L37 |
| 12:30:33.734; 806 | 2875; 22.7/2852.3 | http.render/state.json/4.4; orchestrator.seat-channel/state.exec/3.0; http.render/state.get/1.9; +13 rows | 13.6/6.1 | 1/1 17/18 4729; S57 | 2997.6 | none recorded nearby |
| 12:30:43.890; 807 | 8268; 3083.4/5184.6 | http.render/registry.json/1458.2; http.render/registry.get/1379.9; http.render/registry.prepare/94.9; +13 rows | 176.8/2.2 | 1/1 17/17 1625; S57 | 8359.4 | none recorded nearby |
| 12:30:46.699; 808 | 2546; 106.4/2439.6 | seat-tick.check/operation/39.2; registry.read/registry.snapshot/32.4; mcp.receipts/mcp-receipts.exec/10.5; +13 rows | 54.3/33.2 | 1/1 20/20 12206; S57 | 2644.4 | none recorded nearby |
| 12:30:54.656; 810 | 2093; 42.0/2051.0 | orchestrator.seat-channel/state.exec/9.2; delivery-progress.restore/delivery-progress.restore.slice/4.8; orchestrator.seat-channel/state.prepare/3.2; +13 rows | 31.6/8.0 | 2/1 9/9 2163; S57 | 2197.6 | none recorded nearby |
| 12:30:57.587; 811 | 1254; 217.9/1036.1 | seat-tick.check/state.exec/49.4; state.document/operation/33.2; registry.read/registry.keyed/32.6; +13 rows | 101.5/9.5 | 5/1 10/10 1691; S57 | 1292.1 | T249 |
| 12:31:04.257; 812 | 5901; 5569.7/331.3 | memory.import.curation/operation/1834.9; memory.import.curation/memory.view.all/739.2; memory.import.curation/state.run/720.6; +13 rows | 88.0/4.6 | 5/1 15/15 6338; S57 | 5968.2 | T250,T251,L38,L39 |
| 12:31:09.035; 813 | 3905; 1076.2/2828.8 | state.document/operation/259.8; http.render/state.json/242.8; http.render/state.all/136.0; +13 rows | 119.9/8.8 | 1/1 16/16 9332; S58 | 3983.7 | T252 |
| 12:31:17.274; 815 | 2283; 12.4/2270.6 | http.render/state.json/4.3; mcp.receipts/mcp-receipts.run/2.0; http.render/state.get/2.0; +11 rows | 5.8/5.5 | 2/2 6/8 540; S58 | 2398.8 | none recorded nearby |
| 12:31:33.632; 816 | 14866; 5161.5/9704.5 | http.render/registry.get/2254.5; http.render/registry.json/2203.3; scanner.worker/scanner.ipc-frame/351.7; +13 rows | 347.3/28.8 | 2/1 4/5 31; S58 | 14896.6 | none recorded nearby |
| 12:32:07.559; 824 | 1918; 16.7/1901.3 | pipelines.controller-job/state.exec/9.5; pipelines.controller-job/state.close/2.1; pipelines.controller-job/state.write-wait/1.0; +13 rows | 13.6/7.2 | 0/0 0/0 0; S58 | 2089.9 | T253,L40 |
| 12:32:24.672; 825 | 1816; 182.9/1633.1 | pipelines.mutation/state.exec/61.9; pipelines.mutation/state.prepare/27.1; pipelines.mutation/state.run/21.2; +13 rows | 92.3/9.1 | 0/0 0/0 0; S59 | 1770.7 | none recorded nearby |
| 12:32:26.165; 826 | 1482; 901.4/580.6 | hosts.retirement/operation/360.7; pipelines.controller-schedule/pipeline.copy/114.1; hosts.retirement/registry.json/81.2; +13 rows | 202.2/42.4 | 0/0 0/0 0; S59 | 1592.5 | T254 |
| 12:32:31.436; 829 | 3530; 2579.5/950.5 | registry.read/registry.snapshot/1120.0; registry.read/registry.iterate/386.2; registry.read/registry.all/156.6; +13 rows | 2382.4/2352.3 | 0/0 0/0 0; S59 | 3591.6 | none recorded nearby |
| 12:32:33.733; 830 | 2288; 446.3/1841.7 | memory.view.all/memory.view.all/159.1; memory.view.get/memory.view.get/67.0; memory.view.iterate/memory.view.iterate/53.6; +13 rows | 70.5/20.8 | 1/1 15/15 1065; S59 | 2391.0 | none recorded nearby |
| 12:32:37.625; 833 | 2112; 40.9/2071.1 | registry.read/registry.keyed/7.8; pipelines.controller-schedule/state.write-wait/7.0; pipelines.controller-schedule/state.exec/5.8; +13 rows | 35.1/8.2 | 1/1 20/20 4934; S59 | 2286.1 | none recorded nearby |
| 12:32:48.659; 839 | 2533; 502.9/2030.1 | registry.write/registry.conversations.all/243.3; registry.write/registry.json/107.5; registry.read/registry.snapshot/53.8; +13 rows | 111.5/54.5 | 12/1 12/12 1229; S59 | 2689.8 | none recorded nearby |
| 12:32:52.970; 841 | 3053; 479.3/2573.7 | pipelines.controller-schedule/registry.get/154.3; pipelines.controller-schedule/registry.json/114.3; registry.read/registry.snapshot/86.7; +13 rows | 163.0/33.1 | 1/1 9/10 3797; S59 | 3189.2 | none recorded nearby |
| 12:32:54.349; 842 | 1079; 357.2/721.8 | registry.read/registry.snapshot/246.8; registry.read/registry.deliveryOperationOwners.iterate/18.9; registry.read/registry.keyed/16.4; +13 rows | 341.1/267.6 | 1/1 6/7 8101; S59 | 1186.7 | none recorded nearby |
| 12:33:13.502; 844 | 1282; 81.5/1200.5 | seat-tick.check/state.exec/32.0; seat-tick.check/state.prepare/14.3; seat-tick.check/state.close/11.8; +13 rows | 53.1/8.1 | 2/1 8/8 1391; S59 | 1388.6 | T255 |
| 12:33:15.039; 845 | 1526; 150.5/1375.5 | prototype.state/operation/49.5; seat-tick.check/state.exec/37.7; seat-tick.check/state.prepare/14.6; +13 rows | 61.2/13.5 | 1/1 8/8 2856; S59 | 1576.7 | T255,T256,L41,L42,L43 |
| 12:33:37.094; 850 | 1975; 145.9/1829.1 | delivery-progress.restore/delivery-progress.restore.slice/35.1; seat-tick.check/state.exec/23.9; done.sweep/state.exec/10.9; +13 rows | 104.4/35.1 | 3/1 4/4 2034; S60 | 2093.7 | T257 |
| 12:33:41.135; 854 | 1882; 489.4/1392.6 | seat-tick.check/state.exec/126.0; role-memory.view/memory.view.all/118.8; seat-tick.check/state.prepare/74.1; +13 rows | 177.4/9.5 | 2/1 3/3 2709; S60 | 1828.2 | none recorded nearby |
| 12:33:57.383; 859 | 4727; 1802.5/2924.5 | seat-tick.check/state.json/992.3; seat-tick.check/state.all/417.7; memory.curation-status/memory.view.all/119.0; +13 rows | 29.1/3.9 | 0/0 0/0 0; S60 | 4894.8 | none recorded nearby |
| 12:34:19.808; 861 | 1635; 186.1/1448.9 | pipelines.mutation/state.exec/61.3; pipelines.mutation/state.run/32.1; pipelines.mutation/state.prepare/24.3; +13 rows | 79.1/8.5 | 0/0 0/0 0; S60 | 1483.4 | none recorded nearby |
| 12:34:21.117; 862 | 1299; 679.0/620.0 | registry.read/registry.snapshot/332.9; pipelines.controller-schedule/pipeline.copy/170.9; prototype.state/operation/47.2; +13 rows | 505.6/345.7 | 0/0 0/0 0; S60 | 1382.6 | T259 |
| 12:34:23.987; 863 | 1735; 123.2/1611.8 | pipelines.mutation/state.exec/36.9; pipelines.mutation/state.run/12.8; registry.read/registry.keyed/12.7; +13 rows | 67.2/7.3 | 0/0 0/0 0; S60 | 1746.6 | none recorded nearby |
| 12:34:26.854; 865 | 1431; 239.1/1191.9 | state.document/operation/40.9; registry.read/registry.keyed/27.8; mcp.page-cursors/liveness.snapshot/24.9; +13 rows | 124.9/24.8 | 0/0 0/0 0; S60 | 1593.5 | none recorded nearby |
| 12:34:33.111; 868 | 2471; 452.7/2018.3 | registry.write/registry.conversations.all/199.4; registry.write/registry.json/90.5; registry.read/registry.snapshot/63.8; +13 rows | 122.4/65.2 | 1/1 1/1 31; S60 | 2596.3 | none recorded nearby |
| 12:34:35.620; 870 | 1498; 111.8/1386.2 | pipelines.mutation/state.exec/24.7; registry.read/registry.snapshot/21.6; prototype.state/operation/11.0; +13 rows | 133.3/21.9 | 4/4 1/1 18; S60 | 1595.3 | none recorded nearby |
| 12:35:02.893; 886 | 1356; 257.4/1098.6 | memory.view.all/memory.view.all/71.7; state.document/operation/42.2; registry.read/registry.keyed/37.3; +13 rows | 79.2/28.5 | 1/1 16/16 231; S61 | 1497.7 | none recorded nearby |
| 12:35:27.985; 896 | 4098; 859.7/3238.3 | http.render/registry.get/339.4; http.render/registry.json/251.1; registry.read/registry.keyed/60.5; +13 rows | 165.1/32.0 | 5/1 8/8 5711; S61 | 4188.3 | T261,T262 |
| 12:36:03.248; 906 | 1074; 258.7/815.3 | seat-tick.check/state.exec/94.4; seat-tick.check/state.prepare/63.0; seat-tick.check/state.json/25.6; +13 rows | 109.7/5.4 | 0/0 0/0 0; S62 | 1090.3 | T264 |
| 12:36:11.533; 907 | 4689; 1674.0/3015.0 | seat-tick.check/state.json/1012.0; seat-tick.check/state.all/363.2; seat-tick.check/state.get/118.7; +13 rows | 61.5/6.7 | 1/1 1/1 4611; S62 | 4797.4 | none recorded nearby |
| 12:36:13.510; 908 | 1546; 196.4/1349.6 | pipelines.mutation/state.exec/50.3; pipelines.mutation/state.run/38.2; pipelines.mutation/state.prepare/23.0; +13 rows | 86.9/8.2 | 6/2 3/3 12; S62 | 1608.2 | T265 |
| 12:36:14.612; 909 | 1090; 445.9/644.1 | scanner.worker/scanner.ipc-frame/153.4; pipelines.controller-schedule/pipeline.copy/105.1; registry.read/registry.snapshot/65.0; +13 rows | 308.5/66.2 | 3/1 3/3 1683; S62 | 1188.5 | T265 |
| 12:36:15.940; 910 | 1320; 478.7/841.3 | scanner.worker/scanner.ipc-frame/303.2; scanner.worker/scanner.ipc-decode/33.8; telegram.outbound-state/telegram-outbound.prepare/23.3; +13 rows | 409.9/50.7 | 3/1 3/3 1087; S62 | 1380.4 | T265 |
| 12:36:18.482; 911 | 2530; 593.5/1936.5 | http.render/registry.get/213.6; http.render/registry.json/192.5; registry.read/registry.keyed/29.9; +13 rows | 131.7/15.2 | 3/1 3/3 3282; S62 | 2592.0 | none recorded nearby |
| 12:36:25.529; 915 | 2259; 403.7/1855.3 | registry.write/registry.conversations.all/196.6; registry.write/registry.json/76.5; registry.read/registry.snapshot/51.6; +13 rows | 97.8/52.6 | 1/1 1/1 1; S62 | 2393.7 | none recorded nearby |
| 12:36:29.100; 917 | 2605; 371.6/2233.4 | pipelines.controller-schedule/registry.get/146.2; pipelines.controller-schedule/registry.json/107.3; pipelines.mutation/state.exec/22.9; +13 rows | 180.6/21.6 | 2/2 1/1 0; S62 | 2695.5 | none recorded nearby |

Transaction context, in the Viewer PID. Holds are contextual measurements kept separate from the exclusive allocation:

| ID | Journal UTC | Collection | Held ms |
| --- | --- | --- | --- |
| T1 | 11:27:38.401 | tasks | 973 |
| T2 | 11:27:39.926 | tasks | 971 |
| T3 | 11:27:42.512 | seat-tick-v3 | 99 |
| T4 | 11:28:06.462 | pipelines | 107 |
| T5 | 11:28:07.539 | tasks | 328 |
| T6 | 11:28:14.020 | tasks | 197 |
| T7 | 11:28:20.613 | pipelines | 102 |
| T8 | 11:28:42.197 | pipelines | 172 |
| T9 | 11:28:44.432 | pipelines | 204 |
| T10 | 11:28:46.549 | pipelines | 157 |
| T11 | 11:28:47.122 | pipelines | 58 |
| T12 | 11:28:57.909 | pipelines | 150 |
| T13 | 11:29:06.013 | bridge_reports | 87 |
| T14 | 11:29:07.648 | bridge_reports | 88 |
| T15 | 11:30:05.665 | tasks | 422 |
| T16 | 11:30:06.510 | tasks | 388 |
| T17 | 11:30:21.016 | tasks | 383 |
| T18 | 11:30:41.463 | tasks | 357 |
| T19 | 11:31:27.103 | tasks | 430 |
| T20 | 11:32:00.447 | seat-channel | 60 |
| T21 | 11:32:05.926 | tasks | 368 |
| T22 | 11:32:38.307 | tasks | 431 |
| T23 | 11:32:38.905 | tasks | 396 |
| T24 | 11:32:56.727 | tasks | 400 |
| T25 | 11:33:00.462 | tasks | 487 |
| T26 | 11:33:03.825 | pipelines | 115 |
| T27 | 11:33:29.053 | role_memory | 1537 |
| T28 | 11:33:50.953 | tasks | 431 |
| T29 | 11:34:35.531 | tasks | 376 |
| T30 | 11:34:42.243 | unspecified | 370 |
| T31 | 11:34:43.035 | role_memory_curation | 118 |
| T32 | 11:34:45.214 | role_memory_curation | 145 |
| T33 | 11:35:04.663 | tasks | 529 |
| T34 | 11:35:19.145 | pipelines | 105 |
| T35 | 11:35:25.278 | role_memory | 103 |
| T36 | 11:35:27.481 | role_memory | 2193 |
| T37 | 11:35:39.197 | tasks | 431 |
| T38 | 11:35:39.696 | tasks | 378 |
| T39 | 11:35:41.471 | pipelines | 99 |
| T40 | 11:35:53.275 | role_memory | 359 |
| T41 | 11:35:56.114 | role_memory | 2814 |
| T42 | 11:37:50.021 | tasks | 786 |
| T43 | 11:37:51.137 | tasks | 889 |
| T44 | 11:38:14.617 | tasks | 580 |
| T45 | 11:38:37.162 | unspecified | 410 |
| T46 | 11:38:38.030 | role_memory_curation | 134 |
| T47 | 11:38:42.579 | role_memory_curation | 240 |
| T48 | 11:38:52.589 | role_memory | 2012 |
| T49 | 11:39:49.694 | unspecified | 4364 |
| T50 | 11:39:50.764 | role_memory_curation | 159 |
| T51 | 11:40:05.106 | role_memory_curation | 233 |
| T52 | 11:40:17.620 | tasks | 493 |
| T53 | 11:40:18.174 | tasks | 434 |
| T54 | 11:40:59.796 | tasks | 411 |
| T55 | 11:42:08.204 | tasks | 460 |
| T56 | 11:42:43.114 | pipelines | 108 |
| T57 | 11:42:53.960 | tasks | 554 |
| T58 | 11:42:54.642 | tasks | 518 |
| T59 | 11:43:23.694 | pipelines | 98 |
| T60 | 11:44:26.965 | tasks | 449 |
| T61 | 11:45:17.946 | tasks | 465 |
| T62 | 11:45:18.743 | tasks | 452 |
| T63 | 11:45:38.094 | tasks | 361 |
| T64 | 11:45:44.855 | tasks | 451 |
| T65 | 11:46:49.203 | pipelines | 112 |
| T66 | 11:47:50.176 | tasks | 495 |
| T67 | 11:47:50.853 | tasks | 483 |
| T68 | 11:48:10.665 | tasks | 507 |
| T69 | 11:48:14.941 | pipelines | 117 |
| T70 | 11:48:25.949 | seat-channel | 112 |
| T71 | 11:48:58.576 | done_items | 59 |
| T72 | 11:49:33.037 | pipelines | 98 |
| T73 | 11:49:52.883 | tasks | 384 |
| T74 | 11:50:15.855 | tasks | 488 |
| T75 | 11:50:16.632 | tasks | 481 |
| T76 | 11:50:29.484 | pipelines | 94 |
| T77 | 11:50:34.118 | tasks | 294 |
| T78 | 11:50:42.751 | tasks | 179 |
| T79 | 11:50:43.399 | pipelines | 86 |
| T80 | 11:50:43.970 | pipelines | 81 |
| T81 | 11:50:44.651 | tasks | 326 |
| T82 | 11:50:53.472 | role_memory | 1430 |
| T83 | 11:52:44.241 | tasks | 350 |
| T84 | 11:52:44.768 | tasks | 388 |
| T85 | 11:52:47.685 | pipelines | 91 |
| T86 | 11:52:58.444 | tasks | 304 |
| T87 | 11:53:50.117 | unspecified | 510 |
| T88 | 11:53:50.949 | role_memory_curation | 129 |
| T89 | 11:53:52.716 | role_memory_curation | 117 |
| T90 | 11:54:10.670 | pipelines | 87 |
| T91 | 11:54:23.295 | tasks | 418 |
| T92 | 11:54:38.178 | pipelines | 90 |
| T93 | 11:55:04.868 | tasks | 388 |
| T94 | 11:55:05.405 | tasks | 373 |
| T95 | 11:55:11.015 | role_memory | 1410 |
| T96 | 11:55:35.676 | tasks | 813 |
| T97 | 11:56:29.731 | tasks | 564 |
| T98 | 11:56:46.142 | tasks | 578 |
| T99 | 11:56:55.224 | bridge_reports | 64 |
| T100 | 11:56:56.830 | bridge_reports | 61 |
| T101 | 11:57:08.366 | tasks | 530 |
| T102 | 11:57:09.183 | tasks | 785 |
| T103 | 11:57:43.563 | tasks | 416 |
| T104 | 11:57:44.771 | tasks | 418 |
| T105 | 11:57:57.633 | tasks | 313 |
| T106 | 11:58:31.161 | role_memory | 1918 |
| T107 | 11:58:48.885 | seat-channel | 142 |
| T108 | 11:59:37.119 | done_items | 60 |
| T109 | 12:00:13.480 | tasks | 478 |
| T110 | 12:00:17.218 | tasks | 506 |
| T111 | 12:00:20.302 | bridge_reports | 55 |
| T112 | 12:00:28.210 | tasks | 423 |
| T113 | 12:00:50.492 | tasks | 358 |
| T114 | 12:01:04.348 | tasks | 562 |
| T115 | 12:01:07.305 | bridge_reports | 51 |
| T116 | 12:01:08.148 | tasks | 714 |
| T117 | 12:01:08.668 | tasks | 450 |
| T118 | 12:01:51.748 | tasks | 345 |
| T119 | 12:02:17.513 | unspecified | 1071 |
| T120 | 12:02:18.298 | role_memory_curation | 126 |
| T121 | 12:02:21.025 | role_memory_curation | 188 |
| T122 | 12:02:40.767 | tasks | 413 |
| T123 | 12:02:41.542 | tasks | 408 |
| T124 | 12:02:50.334 | role_memory | 1327 |
| T125 | 12:02:51.639 | tasks | 291 |
| T126 | 12:03:38.708 | pipelines | 92 |
| T127 | 12:04:19.890 | tasks | 315 |
| T128 | 12:04:26.447 | unspecified | 3043 |
| T129 | 12:04:27.158 | role_memory_curation | 109 |
| T130 | 12:04:30.059 | role_memory_curation | 129 |
| T131 | 12:05:08.700 | tasks | 395 |
| T132 | 12:05:09.595 | tasks | 366 |
| T133 | 12:05:20.915 | unspecified | 463 |
| T134 | 12:05:21.330 | role_memory_curation | 127 |
| T135 | 12:05:23.104 | role_memory_curation | 130 |
| T136 | 12:05:25.692 | tasks | 286 |
| T137 | 12:06:05.687 | tasks | 190 |
| T138 | 12:06:05.902 | tasks | 192 |
| T139 | 12:06:06.121 | tasks | 187 |
| T140 | 12:06:06.324 | tasks | 184 |
| T141 | 12:06:06.551 | tasks | 175 |
| T142 | 12:06:06.796 | tasks | 198 |
| T143 | 12:06:06.994 | tasks | 185 |
| T144 | 12:06:07.263 | tasks | 203 |
| T145 | 12:06:07.520 | tasks | 192 |
| T146 | 12:06:07.707 | tasks | 173 |
| T147 | 12:06:08.200 | tasks | 181 |
| T148 | 12:06:08.393 | tasks | 172 |
| T149 | 12:06:08.579 | tasks | 175 |
| T150 | 12:06:08.778 | tasks | 174 |
| T151 | 12:06:09.003 | tasks | 170 |
| T152 | 12:06:09.192 | tasks | 172 |
| T153 | 12:06:09.382 | tasks | 173 |
| T154 | 12:06:09.572 | tasks | 177 |
| T155 | 12:06:09.771 | tasks | 185 |
| T156 | 12:06:10.060 | tasks | 195 |
| T157 | 12:06:10.247 | tasks | 172 |
| T158 | 12:06:10.423 | tasks | 163 |
| T159 | 12:06:10.606 | tasks | 172 |
| T160 | 12:06:10.843 | tasks | 179 |
| T161 | 12:06:27.217 | unspecified | 354 |
| T162 | 12:06:28.028 | role_memory_curation | 127 |
| T163 | 12:06:29.686 | role_memory_curation | 122 |
| T164 | 12:06:36.374 | pipelines | 89 |
| T165 | 12:07:09.386 | tasks | 425 |
| T166 | 12:07:33.299 | tasks | 365 |
| T167 | 12:07:33.993 | tasks | 368 |
| T168 | 12:07:43.976 | tasks | 319 |
| T169 | 12:08:04.341 | pipelines | 84 |
| T170 | 12:08:32.948 | tasks | 334 |
| T171 | 12:08:48.239 | tasks | 319 |
| T172 | 12:10:07.219 | tasks | 414 |
| T173 | 12:10:09.929 | tasks | 445 |
| T174 | 12:10:10.545 | tasks | 455 |
| T175 | 12:10:21.019 | tasks | 355 |
| T176 | 12:12:18.423 | tasks | 347 |
| T177 | 12:12:28.036 | pipelines | 79 |
| T178 | 12:12:33.599 | tasks | 392 |
| T179 | 12:12:34.655 | tasks | 641 |
| T180 | 12:12:36.843 | role_memory | 510 |
| T181 | 12:12:38.686 | role_memory | 1836 |
| T182 | 12:12:48.149 | tasks | 281 |
| T183 | 12:12:58.105 | role_memory_curation | 73 |
| T184 | 12:12:58.567 | tasks | 170 |
| T185 | 12:12:59.474 | tasks | 299 |
| T186 | 12:13:52.561 | pipelines | 138 |
| T187 | 12:14:26.262 | bridge_reports | 69 |
| T188 | 12:14:29.248 | tasks | 398 |
| T189 | 12:15:05.973 | unspecified | 1091 |
| T190 | 12:15:06.639 | role_memory_curation | 186 |
| T191 | 12:15:09.333 | role_memory_curation | 216 |
| T192 | 12:15:25.572 | tasks | 447 |
| T193 | 12:15:26.492 | tasks | 748 |
| T194 | 12:15:35.532 | tasks | 564 |
| T195 | 12:16:35.717 | pipelines | 85 |
| T196 | 12:16:41.832 | pipelines | 87 |
| T197 | 12:17:03.876 | pipelines | 90 |
| T198 | 12:17:21.332 | role_memory | 241 |
| T199 | 12:17:22.886 | role_memory | 1545 |
| T200 | 12:17:25.821 | pipelines | 82 |
| T201 | 12:17:36.875 | tasks | 455 |
| T202 | 12:17:37.839 | tasks | 428 |
| T203 | 12:17:49.951 | tasks | 315 |
| T204 | 12:17:51.913 | pipelines | 90 |
| T205 | 12:18:06.821 | pipelines | 90 |
| T206 | 12:18:27.363 | tasks | 312 |
| T207 | 12:18:33.433 | tasks | 323 |
| T208 | 12:19:23.153 | tasks | 324 |
| T209 | 12:20:05.607 | tasks | 381 |
| T210 | 12:20:06.286 | tasks | 409 |
| T211 | 12:20:15.887 | tasks | 361 |
| T212 | 12:20:23.110 | tasks | 596 |
| T213 | 12:20:31.515 | pipelines | 108 |
| T214 | 12:20:57.151 | unspecified | 504 |
| T215 | 12:21:54.144 | pipelines | 126 |
| T216 | 12:22:01.431 | role_memory | 1101 |
| T217 | 12:22:03.232 | role_memory | 1793 |
| T218 | 12:22:35.504 | tasks | 422 |
| T219 | 12:22:42.557 | tasks | 459 |
| T220 | 12:22:46.614 | tasks | 617 |
| T221 | 12:23:01.655 | tasks | 342 |
| T222 | 12:23:26.749 | role_memory | 265 |
| T223 | 12:23:28.397 | role_memory | 1633 |
| T224 | 12:23:58.844 | pipelines | 88 |
| T225 | 12:25:10.742 | tasks | 398 |
| T226 | 12:25:12.986 | tasks | 652 |
| T227 | 12:25:14.112 | tasks | 608 |
| T228 | 12:25:30.994 | pipelines | 97 |
| T229 | 12:25:35.836 | tasks | 571 |
| T230 | 12:25:39.934 | role_memory | 1224 |
| T231 | 12:25:41.713 | role_memory | 1770 |
| T232 | 12:25:49.144 | unspecified | 1179 |
| T233 | 12:25:49.932 | role_memory_curation | 167 |
| T234 | 12:25:51.979 | role_memory_curation | 176 |
| T235 | 12:26:10.978 | pipelines | 89 |
| T236 | 12:26:17.293 | role_memory | 1595 |
| T237 | 12:26:21.346 | tasks | 518 |
| T238 | 12:26:30.388 | unspecified | 3089 |
| T239 | 12:26:31.962 | done_items | 57 |
| T240 | 12:26:58.662 | done_items | 55 |
| T241 | 12:27:59.458 | done_items | 50 |
| T242 | 12:28:21.315 | tasks | 767 |
| T243 | 12:28:22.204 | tasks | 700 |
| T244 | 12:30:12.957 | done_items | 66 |
| T245 | 12:30:13.927 | pipelines | 92 |
| T246 | 12:30:17.478 | unspecified | 2080 |
| T247 | 12:30:27.482 | role_memory | 1117 |
| T248 | 12:30:29.625 | role_memory | 2130 |
| T249 | 12:30:57.201 | tasks | 616 |
| T250 | 12:31:02.515 | unspecified | 3502 |
| T251 | 12:31:03.896 | role_memory_curation | 223 |
| T252 | 12:31:08.392 | role_memory_curation | 407 |
| T253 | 12:32:07.538 | role_memory | 1895 |
| T254 | 12:32:26.104 | tasks | 554 |
| T255 | 12:33:13.310 | tasks | 955 |
| T256 | 12:33:14.815 | tasks | 1041 |
| T257 | 12:33:36.772 | tasks | 608 |
| T258 | 12:33:58.952 | pipelines | 125 |
| T259 | 12:34:20.999 | tasks | 540 |
| T260 | 12:35:05.998 | pipelines | 114 |
| T261 | 12:35:23.662 | tasks | 616 |
| T262 | 12:35:27.801 | tasks | 799 |
| T263 | 12:35:32.384 | tasks | 717 |
| T264 | 12:36:01.708 | tasks | 402 |
| T265 | 12:36:14.292 | tasks | 511 |

Collection lease context. The journal PID belongs to the forwarding launcher; owner PID is inferred only where an adjacent explicit Viewer transaction agrees in timestamp and duration. This association is contextual. Paired leases from one apply must be unioned, and are never added as independent time:

| ID | Journal UTC | Collection | Operation | Held ms | Owner PID |
| --- | --- | --- | --- | --- | --- |
| L1 | 11:27:38.421 | task_tombstones | seat-tick.check | 1003.0 | 3875509 |
| L2 | 11:28:42.364 | pipelines | pipelines.mutation | 1153.0 | unresolved |
| L3 | 11:33:29.056 | role_memory | pipelines.controller-job | 1544.0 | 3875509 |
| L4 | 11:35:27.484 | role_memory | http.render | 2198.0 | 3875509 |
| L5 | 11:35:56.121 | role_memory | http.render | 2829.0 | 3875509 |
| L6 | 11:38:52.597 | role_memory | pipelines.controller-job | 2026.0 | 3875509 |
| L7 | 11:39:49.704 | role_memory_curation | memory.import.curation | 4378.0 | 3875509 |
| L8 | 11:39:49.709 | role_memory | memory.import.curation | 4386.0 | 3875509 |
| L9 | 11:50:53.475 | role_memory | pipelines.controller-job | 1436.0 | 3875509 |
| L10 | 11:55:11.023 | role_memory | pipelines.controller-job | 1420.0 | 3875509 |
| L11 | 11:58:31.165 | role_memory | pipelines.controller-job | 1926.0 | 3875509 |
| L12 | 12:02:17.517 | role_memory_curation | memory.import.curation | 1078.0 | 3875509 |
| L13 | 12:02:17.520 | role_memory | memory.import.curation | 1083.0 | 3875509 |
| L14 | 12:02:50.337 | role_memory | pipelines.controller-job | 1332.0 | 3875509 |
| L15 | 12:04:26.455 | role_memory_curation | memory.import.curation | 3052.0 | 3875509 |
| L16 | 12:04:26.457 | role_memory | memory.import.curation | 3057.0 | 3875509 |
| L17 | 12:12:38.691 | role_memory | http.render | 1842.0 | 3875509 |
| L18 | 12:13:52.647 | pipelines | pipelines.mutation | 1368.0 | unresolved |
| L19 | 12:15:05.977 | role_memory_curation | memory.import.curation | 1096.0 | 3875509 |
| L20 | 12:15:05.979 | role_memory | memory.import.curation | 1102.0 | 3875509 |
| L21 | 12:17:22.888 | role_memory | http.render | 1550.0 | 3875509 |
| L22 | 12:22:01.434 | role_memory | http.render | 1106.0 | 3875509 |
| L23 | 12:22:03.236 | role_memory | http.render | 1800.0 | 3875509 |
| L24 | 12:23:28.401 | role_memory | http.render | 1639.0 | 3875509 |
| L25 | 12:25:39.938 | role_memory | http.render | 1230.0 | 3875509 |
| L26 | 12:25:41.718 | role_memory | http.render | 1778.0 | 3875509 |
| L27 | 12:25:49.148 | role_memory_curation | memory.import.curation | 1185.0 | 3875509 |
| L28 | 12:25:49.150 | role_memory | memory.import.curation | 1191.0 | 3875509 |
| L29 | 12:26:17.298 | role_memory | pipelines.controller-job | 1606.0 | 3875509 |
| L30 | 12:26:30.395 | role_memory_curation | memory.import.curation | 3097.0 | 3875509 |
| L31 | 12:26:30.401 | role_memory | memory.import.curation | 3107.0 | 3875509 |
| L32 | 12:26:57.853 | tasks | tasks.mutation | 1182.0 | unresolved |
| L33 | 12:26:57.862 | task_tombstones | task_tombstones.mutation | 1197.0 | unresolved |
| L34 | 12:30:17.483 | role_memory_curation | memory.import.curation | 2087.0 | 3875509 |
| L35 | 12:30:17.488 | role_memory | memory.import.curation | 2098.0 | 3875509 |
| L36 | 12:30:27.486 | role_memory | http.render | 1123.0 | 3875509 |
| L37 | 12:30:29.629 | role_memory | http.render | 2138.0 | 3875509 |
| L38 | 12:31:02.519 | role_memory_curation | memory.import.curation | 3508.0 | 3875509 |
| L39 | 12:31:02.522 | role_memory | memory.import.curation | 3514.0 | 3875509 |
| L40 | 12:32:07.541 | role_memory | pipelines.controller-job | 1901.0 | 3875509 |
| L41 | 12:33:14.826 | task_tombstones | seat-tick.check | 1063.0 | 3875509 |
| L42 | 12:33:15.127 | tasks | seat-tick.check | 1358.0 | unresolved |
| L43 | 12:33:15.145 | tasks | seat-tick.check | 1376.0 | unresolved |

Separate waiter telemetry, excluded from the exclusive allocation:

| Site | Synchronous | Records | Total ms | Maximum ms |
| --- | --- | --- | --- | --- |
| file-transaction | False | 543 | 690,476.800 | 6,358.200 |
| state-write-lock | False | 1000 | 355,334.700 | 5,763.700 |
| snapshot-transfer | False | 80 | 224,074.100 | 15,658.600 |
| registry-lock-async | False | 9 | 4,788.900 | 793.500 |
| state-write-lock | True | 23 | 75.700 | 9.000 |

Registry writer-holder mentions. An age supplies a lower bound on a hold and receives no extra allocation:

No matching holder/PID/age line in the bounded journal read.

</details>

<!-- ledger:end -->

## 3. Relation to deferred and concurrent work

The mapping below uses the final deferred list in
[section 10 of the earlier design](viewer-stalls-root-cause.md#10-deferred-with-the-reason).
Shares name observed occupancy. A reader family alone cannot establish the
specific algorithm, collection or call site that caused it.

<!-- mapping:start -->
| Observed share | Existing item or owner | What the records establish; next boundary |
| --- | --- | --- |
| Residual: 72.6293% | Section 10: function-level profile | No function owns this time in the retained records. Section 4 proposes bounded diagnosis; no repair saving is assigned. |
| Registry: 9.0661% | Section 10: plain snapshot, keyed overlay, receipts and other lock holders | registry.keyed 2.6740%; registry.snapshot 1.9211%; registry.receipts.all 0.0616%. These do not prove the dirty-overlay mechanism or a startup receipts sweep. Separate caller attribution is still owed. |
| State: 7.3383% | Section 10: task transactions, synchronous waits; PR 3857 for particular memory callers | state.write-wait 0.4353% is measured directly. Broad state.all/state.json labels do not identify a collection. Credit PR 3857 only after a narrowed read is measured; its possible native/GC benefit stays unquantified. |
| Role-memory readers: 2.7411% | Section 10: scope history; merged PRs 3841 and 3857 | Both changes are included in successor release 662a6012. This is 10.01% of attributed gap time on 692e5338; the calculation and limits are below. History migration and savings still need verification. No overlapping edit is proposed. |
| Curator context: 2.8969% (overlaps the family rows) | Deferred fix 4, after PR 3841 | Measured operation context includes body and readers. The explicit 4364 ms transaction beside the 6373 ms gap at 11:39:51 confirms a surviving hold. Re-measure after history migration before sizing a separate apply repair. |
| Operation bodies: 3.9624% | Section 10 profile; some bodies belong to deferred fix 4 | Exclusive body counters identify a context without an internal function. A new call-site cause remains unwritten until sampled. |
| Other readers: 2.9464% | Newly separated observation: scanner IPC and miscellaneous readers | scanner.ipc-frame 1.3926%. This is serving-thread frame processing, distinct from worker CPU. A generic scanner label does not establish which caller or payload shape caused it. |
| Named tail: 1.3164% | Telemetry capacity limitation | Duration is measured; family and exact caller were omitted. Do not redistribute it across visible families. |
| Runtime host: 0.2869% of its own wall time | Section 10: snapshot rebuild, idle liveTurn and retirement policy | Measured separately from Viewer gaps. Existing snapshot work and any retirement decision retain their owners; this is no share of the Viewer residual. |
| No numerical share assigned | Section 10: direct yields, migration start, opt-out reads, key retry, auto_vacuum and stopped-state presentation | The current records do not isolate these mechanisms. Few cooperative resumes exclude many resumed queue slices in those records, and say nothing about unsliced work or first slices. No speculative savings are assigned. |

<!-- mapping:end -->

[PR 3841](https://github.com/latand/delegatus/pull/3841) changes scope history
storage, its drain, the history readers and curator apply. Its migration
ships disabled and requires the operator's store-specific activation and
backup. Merely merging the PR does not establish that existing history has
moved. [PR 3857](https://github.com/latand/delegatus/pull/3857) narrows rule,
request, membership and problem reads, including the privacy matcher,
learned-rule loading and seat reads. PR 3841 merged at 12:07:04 as `941e0193`; PR 3857 merged at
12:29:01 as `662a6012`. Both merges occurred while the measured process
continued serving `692e5338`. The next deployment switched at 12:37:23.816
and carries both changes. Their actual changed-file lists and production
hunks were inspected; the status was rechecked at 12:41:09. The follow-up must measure their deployed
behavior before assigning any remaining work in those files.

[PR 3851](https://github.com/latand/delegatus/pull/3851), merged as the measured
release `692e5338`, already supplies operator heap statistics and a guarded
snapshot. `src/lib/heapDiagnostics.ts` walks the heap on the serving thread;
its statistics path can also remove partial snapshots. It was not invoked.
Heap growth and a decrease in RSS cannot by themselves attribute a gap to
garbage collection. These diagnostics remain with their existing owner.

The runtime-host gap monitor samples slow windows. Its retained collect and
stringify spans cannot establish the median over every snapshot rebuild,
including the rebuilds that produced no gap. The original under-100-ms
snapshot target therefore still needs a separate complete series.

### Release change: the footprint of PRs 3841 and 3857

The installed successor `662a6012` contains both merged changes. The
measurement above covers their predecessor throughout. The attributable
denominator on that predecessor is **299.875 seconds**, calculated as
1,095.605 seconds of gaps minus 795.730 seconds of residual. Family and
operation tables use the same frozen window,
11:27:27.000 to 12:37:23.816 UTC.

| Footprint in the existing attribution | Seconds | Share of attributed gap time | Interpretation after the release change |
| --- | --- | --- | --- |
| Directly labelled `memory.view.*` readers | 30.032 | 10.01% | These readers belong to `src/lib/memory/roleViewSource.ts`, which both PRs changed. This identifies occupancy in the changed module; records do not name the SQL statement or every changed function. |
| `memory.import.curation` context | 31.739 | 10.58% | PR 3841 changes scope-history access and appending in curator apply. This context also contains other work, so its full duration is a ceiling for a repair of that context. |
| `role-memory.view` context | 18.540 | 6.18% | PR 3841 changes the project-view history inputs. Generic state readers inside this context belong to its footprint even when their reader label is `state.*`. |
| The two operation contexts combined | 50.279 | 16.77% | The contexts are disjoint in the exclusive operation accounting. They overlap the reader-family row above; their percentages must not be added to its 10.01%. |

The **10.01%** is the directly labelled footprint available to the plan.
The **16.77%** supplies a broader context footprint for prioritizing the
successor measurement. The records cannot calculate an exact union of
changed statements from these aggregate views. In particular, PR 3857's
privacy, learned-rule, lesson-request and problem reads often appear under
generic `state.*`, HTTP or seat contexts. The records provide no exclusive
duration for those changed callers, and some privacy work runs in workers
excluded from the Viewer denominator. Its additional share remains
unquantified.

The plan should discount duplicate implementation in the history and
read paths those PRs already own. No numerical reduction in the new
release's gap budget is established yet: PR 3841's drain requires its
operator switch and backup, and even a changed caller retains useful
work. The 795.730-second residual (72.6293% of all gaps), the 14.423-second
named tail, and unrelated registry, state and scanner work remain
unexplained or independently owned. Neither PR's merge justifies
discounting them. Any native allocation or GC benefit is also
unmeasured. The curator transaction of 4.364 seconds remains evidence
of deferred fix 4 on the predecessor; its successor duration must be
measured before another apply change is sized.

The calculation below reads only the retained document. Its inputs have
millisecond display precision, so attributed-share percentages are
rounded to two decimals. It neither queries the journal again nor
re-measures the predecessor. The source check compares each merge to its
parent, avoiding the stale file lists in the initial brief. The
calculation and merge-file recheck ran at
**2026-11-11T13:25:02.111768Z to 13:25:02.159059Z**; the inputs retain
the frozen cohort's time bounds above:

```bash
git diff 941e0193^ 941e0193 -- src/lib/memory/roleViewSource.ts src/lib/memory/roleStore.ts src/lib/memory/curation/apply.ts src/lib/memory/curation/store.ts
git diff 662a6012^ 662a6012 -- src/lib/memory/roleViewSource.ts src/lib/memory/roleStore.ts src/lib/memory/roleProblems.ts
python3 - <<'PY'
from pathlib import Path
from decimal import Decimal
s = Path('docs/design/viewer-stalls-after-3846.md').read_text()
a = s[s.index('<!-- attribution:start -->'):s.index('<!-- attribution:end -->')]
def seconds(label):
    line = next(line for line in a.splitlines() if line.startswith('| ' + label + ' |'))
    return Decimal(line.split('|')[2].strip().replace(',', ''))
gap = Decimal('1095.605')
named = gap - seconds('Unattributed')
print('attributed seconds', named)
for label in ['Role-memory readers', 'memory.import.curation', 'role-memory.view']:
    value = seconds(label)
    print(label, value, f'{100 * value / named:.2f}% of attributed time')
combined = seconds('memory.import.curation') + seconds('role-memory.view')
print('combined contexts', combined, f'{100 * combined / named:.2f}% of attributed time')
PY
```

The retained command output is `attributed seconds 299.875`, followed by
`Role-memory readers 30.032 10.01%`,
`memory.import.curation 31.739 10.58%`,
`role-memory.view 18.540 6.18%`, and
`combined contexts 50.279 16.77%` (each percentage uses attributed time).

## 4. Seeing inside the residual

The least disruptive next step is a short, explicitly approved sampling
session using the existing Viewer recorder. The recorder already exists in
`src/lib/loopProfiler.ts` and `src/lib/loopProfilerServing.ts`; it was shipped
before this repair. The read at 12:03:42 found `loop-profiler.json` holding
`enabled=false` and the deploy ledger naming `692e5338`. The gap records
say `not-armed/profiler-not-started`. The setting and ledger were left intact.
The current startup entry point cannot arm this already running process.

The proposed implementation adds an operator-only, same-origin, one-shot
arm and cancel surface around that recorder. It keeps the existing startup
kill switch authoritative, takes explicit consent for the single capture,
and returns the serving PID, start identity, revision and fixed expiry.
The initial surface is API-only. Arming refuses while the stored kill switch
is disabled; changing that setting remains a separate operator choice.
There is one owner and one in-flight recording per Viewer process. A second
request refuses. The first recording keeps its original expiry. A new deploy
does not inherit an unfinished manual recording.
Reuse the serving monitor and one shared process owner across compiled
route bundles, so route-local module instances cannot create extra owners.
Manual arming also refuses while the automatic deploy recorder is active.
Rate-limit new manual arms to one per hour per process, and make retries of
the same arm id return its status without starting another capture.

The builder's API contract is fixed:

- `POST /api/operator/loop-profile` accepts an arm id and the expected
  serving PID, start identity and revision. Recheck that binding before
  collection and reject a stale identity. Capture duration, sample interval
  and burst count are server constants. Return the binding, monotonic
  start, UTC expiry and capture status immediately, without waiting for
  the bursts.
- `GET` reads the status of that arm, with its same operator authority.
  It starts no work. `DELETE` cancels that arm and records whether native
  collection is still returning. Neither operation renews the expiry.
- All methods reject agent and Viewer service identities. Mutations use
  the existing cross-origin and restart-handoff guards. An unknown arm,
  an active automatic recorder, a disabled switch and a busy manual
  recorder each have a distinct fixed refusal reason. Failed captures
  terminate the arm; they do not retry themselves.

Record two five-second bursts at a 10,000-microsecond sampling interval.
Correlate sample timestamps with the monitor's sequence and monotonic gap
bounds. The rehearsal must establish the native timestamp's unit and clock
on Bun 1.4.0. Clip samples to each gap before calculating its weights; keep
whole-burst weights separate. The current recorder copies one burst summary
to its overlapping gaps, so those summaries alone cannot divide gap time.
Retain static source locations, self and inclusive sample counts,
the total and inspected sample counts, omitted/native samples and all
existing reader, scheduler and cooperative fields. Emit only the existing
privacy-filtered summary, capped at 8,192 bytes per gap. Keep raw stacks out
of journals, public documents and operator responses. Dynamic function
names, request data, account names and absolute paths are excluded by the
existing source-location filter.

The builder must preserve the distinction between the API argument's
microseconds and the raw profile's interval in seconds. Bun documents
timestamps on individual raw traces; their epoch and scale still require
the pinned-runtime rehearsal. See the official
[raw profile schema](https://bun.com/reference/bun/jsc/SamplingProfileStackTraces),
checked on 2026-11-11. If timestamps cannot be aligned to the monitor,
report whole-burst samples and a correlation-unavailable outcome; assign
no per-gap weights. Weight denominators include filtered and native
samples, and a sample contributes at most once to a function's inclusive
count.

Keep the existing two-second profile correlation threshold explicit. If
neither burst overlaps a qualifying gap, return that outcome with its
coverage; it establishes no cause or improvement. Another capture requires
a new operator request. Sampling only the recovery callback would miss the
work that blocked the loop.

Operating costs require the rehearsal below. The existing
collector limits postprocessing to 4,096 samples, depth 32, 128 candidate
frames and 16 output rows, with at most eight source files and 2 MiB of
source metadata. Native collection itself has no demonstrated hard memory
cap. A five-second callback can finish late when the serving loop stalls;
its timer cannot interrupt a synchronous native call. Therefore the native
buffer and deadline behavior must first be measured on the pinned Bun
runtime, on isolated data with induced long stalls. A bounded output does
not prove bounded collection.

The proposed rehearsal accepts the capture only with less than 2% extra
main-thread CPU over paired runs and less than 32 MiB extra RSS, no retained
raw profile after completion, and summary processing below 10 ms per burst.
These are acceptance targets. The rehearsal must show cancellation,
expiry after a late timer, a second arm refusal, process succession, capture
failure, and privacy filtering against the real compiled Viewer bundle.
If those bounds cannot be demonstrated, the manual arm remains unavailable.

The arm request has an absolute 15-second expiry and permits no renewal.
Cancel and the existing disabled setting prevent further bursts. An active
native call is allowed to return before disposal; the interface reports
that delayed stop honestly. A separate observer stops only its own capture
helper, identified at launch, if a future external sampler is used.

The 15-second expiry bounds admission of further work. The native API
offers no demonstrated interrupt or hard collection-memory limit. State
that limitation in the operator response and retain requested versus
actual end time and late-stop reason. A strict wall-clock or memory cap
cannot be promised for this in-process recorder. If the rehearsal cannot
justify that exposure on a naturally stalling Viewer, leave manual arming
disabled and use the separately reviewed external sampler below. Its
helper deadline and fixed ring must be independent of the serving loop.

JavaScriptCore sampling can identify the JavaScript functions behind the
residual; native and filtered frames may remain unresolved. The API records
stacks until the callback settles, according to the
[Bun profile reference](https://bun.com/reference/bun/jsc/profile).
If it leaves the high-CPU residual unexplained, a separately approved
15-second native sample of the single Viewer main thread is the next
escalation: proposed frequency 49 Hz, user-space stacks, a fixed-size ring,
bounded private output, recorded lost samples and a fixed helper deadline.
No heap snapshot, debugger pause, restart or generated traffic is part of
either proposal. The read at 12:06:17 found `perf_event_paranoid=4`; native
sampling permissions were not tested. A native capture would need its
access and symbolization proven in an isolated rehearsal first. No kernel
setting change is proposed.

This stage runs neither sampling method. The first follow-up lane can
implement and rehearse the one-shot wrapper in the existing profiler files,
`src/app/api/operator/loop-profile/route.ts`, the existing
`src/lib/loopProfiler.test.ts` and a direct route test, with two independent
review rounds. The route uses the operator authority and same-origin checks
already used by the heap route. Preserve the existing deploy ledger and
startup behavior; manual arms have their own process-local owner and expiry.
Any expansion into the runtime host, deployment or Bun pin requires the
project's three review rounds. It must avoid the history and heap
diagnostic files owned above. Its production acceptance is information:
correlated, privacy-safe frames for naturally occurring residual gaps,
measured capture overhead and an automatic stop. Expected gap time removed
by diagnosis itself is zero. The implementation plan must derive repair
estimates from those samples and the measured shares in section 2.

The first plan item can use this build boundary: process-local manual
ownership and the API above, timestamp correlation in the existing
recorder, privacy-filtered summaries, and isolated rehearsals against the
production Viewer bundle on Bun 1.4.0. Include tests for cancellation
during collection, expiry reached inside a long synchronous stall, zero
qualifying gaps, malformed timestamps, overlapping reader frames,
filtered/native coverage, an already active automatic recorder and a
release change. Prove that status reads cannot arm the recorder and that
the deployed-revision ledger is unchanged. Acceptance is a measured
capture with honest coverage and bounded follow-up work; it supplies no
gap-reduction credit. A live capture remains a later operator action,
after the separate 90-minute baseline has been retained.

### Reproduction and retained observations

The continuation rechecked source at **2026-11-11T13:26:40.388425Z to
13:26:40.429021Z**. Assigned HEAD remained `1a2e577f`; the local
`origin/main` ref was `e4215ed9`. The command below returned no diff for
the reference design, profiler or attribution implementation since
`662a6012`. These are local ref observations; they make no claim about a
later serving release or an uncaptured remote head.

```bash
git rev-parse HEAD origin/main
git diff 662a6012 origin/main -- docs/design/viewer-stalls-root-cause.md src/lib/loopProfiler.ts src/lib/loopProfilerServing.ts src/lib/readAttribution.ts
```

Source and deployment provenance were rechecked at 12:42:32.103 UTC. The source digest rows are [path, SHA-256 on 692e5338, equal to assigned HEAD, equal to origin/main]. The sole monitor difference on the new main is an additional memory.history-drain operation label; its counter implementation is unchanged. The assigned HEAD stayed at 1a2e577f while origin/main advanced to 662a6012. PR status was checked against GitHub at 12:41:09 UTC. The new release is a separate cohort containing both history PRs.

```json
{
  "readUTC": "2026-11-11T12:42:32.103701Z",
  "head": "1a2e577f2a9f1357ffe9822edb00665c81d93cb5",
  "originMain": "662a6012b39f051669da557d828c13b9e82aa27d",
  "apply": {
    "target": "662a6012b39f051669da557d828c13b9e82aa27d",
    "state": "done",
    "trigger": "operator",
    "startedAt": "2026-11-11T12:31:11.902Z",
    "switchedAt": "2026-11-11T12:37:23.816Z",
    "rolledBack": false
  },
  "web": {
    "pid": 946855,
    "revision": "662a601",
    "startedAt": "2026-11-11T12:37:44.306Z"
  },
  "runtimeHost": {
    "pid": 934406,
    "revision": "662a601",
    "startedAt": "2026-11-11T12:37:27.820Z"
  },
  "sourceSHA256": [
    [
      "src/lib/viewerLoopMonitor.ts",
      "91af27429305fb9135a1515564fda960769c60e171a91d34e3eee266aa07b107",
      true,
      false
    ],
    [
      "src/lib/readAttribution.ts",
      "346f13046dbba4db3f3806814a47acd7ba4fad43adf8177793120b574e5138ec",
      true,
      true
    ],
    [
      "src/lib/loopProfiler.ts",
      "34a2d330b23e28db5c1c76ef16a31962643d91fbccc93494854e0862d848f9ac",
      true,
      true
    ],
    [
      "src/lib/loopProfilerServing.ts",
      "7169d123d110739b9701dc26e7df2ff1bc99f785620b73584136bc7b95e34948",
      true,
      true
    ],
    [
      "src/lib/cooperative.ts",
      "6915431b8add6e6da385fcb0487d826a1479ad4efc6e11911b9a8e329f6ea242",
      true,
      true
    ],
    [
      "src/lib/state/sqliteStateStore.ts",
      "61cda1e19d59190fdf73a0c56b2015733b58b2e7a5596b4deefc97863abf7343",
      true,
      true
    ],
    [
      "src/lib/agent/sqliteRegistryStore.ts",
      "70a7c94afad8d522ce793dad673cfaa7e996fce2d1d41c8d1d87d5206544a99d",
      true,
      true
    ],
    [
      "docs/design/viewer-stalls-root-cause.md",
      "fe9b5091237c3758dbea0f5916d519f369b5930fd12df876ec59992ba8b712e9",
      true,
      true
    ]
  ]
}
```

The source, primary deployment fields and PR status reads use this read-only command; source and deployment fields above retain the earlier read's values if state later changes:

```bash
python3 - <<'PY'
import pathlib,subprocess,json,hashlib,datetime,urllib.request
files=['src/lib/viewerLoopMonitor.ts','src/lib/readAttribution.ts','src/lib/loopProfiler.ts','src/lib/loopProfilerServing.ts','src/lib/cooperative.ts','src/lib/state/sqliteStateStore.ts','src/lib/agent/sqliteRegistryStore.ts','docs/design/viewer-stalls-root-cause.md']
print(datetime.datetime.now(datetime.timezone.utc).isoformat())
for f in files:
 a=subprocess.check_output(['git','show','692e5338:'+f]);b=subprocess.check_output(['git','show','HEAD:'+f]);c=subprocess.check_output(['git','show','origin/main:'+f])
 print(json.dumps([f,hashlib.sha256(a).hexdigest(),a==b,a==c]))
root=pathlib.Path.home()/'.config/delegatus/state/self-update'
a=json.loads((root/'apply.json').read_text());l=json.loads((root/'launcher-bb38046574072bf9.json').read_text())
print(json.dumps({k:a.get(k) for k in ['target','state','trigger','startedAt','switchedAt','rolledBack']}))
for kind in ['web','runtimeHost']:
 print(kind,json.dumps({k:l[kind].get(k) for k in ['pid','revision','startedAt']}))
for n in [3841,3857,3851]:
 with urllib.request.urlopen(urllib.request.Request(f'https://api.github.com/repos/latand/delegatus/pulls/{n}',headers={'User-Agent':'read-only-stage'}),timeout=15) as r:x=json.load(r)
 print(json.dumps({'number':n,'state':x['state'],'mergedAt':x['merged_at'],'mergeCommit':x['merge_commit_sha'],'head':x['head']['sha'],'base':x['base']['sha']}))
PY
```

Pre-apply sensitivity manifest and result:

```json
[
  {
    "lo": "2026-11-11T11:27:27.000Z",
    "hi": "2026-11-11T12:31:11.902Z",
    "readStart": "2026-11-11T12:43:11.064Z",
    "readEnd": "2026-11-11T12:43:12.598Z",
    "digest": "6cba7f9117282a21719a492d84ffdc27eb4ffcf3c478a1a2b7c488e0d04501a4",
    "fetch": [
      [
        "2026-11-11T11:25:27.000Z",
        "2026-11-11T11:40:27.000Z",
        1781
      ],
      [
        "2026-11-11T11:40:27.000Z",
        "2026-11-11T11:55:27.000Z",
        1548
      ],
      [
        "2026-11-11T11:55:27.000Z",
        "2026-11-11T12:10:27.000Z",
        1968
      ],
      [
        "2026-11-11T12:10:27.000Z",
        "2026-11-11T12:25:27.000Z",
        1212
      ],
      [
        "2026-11-11T12:25:27.000Z",
        "2026-11-11T12:33:11.902Z",
        842
      ]
    ]
  },
  {
    "viewer": 25.19693315018267,
    "viewerGapMs": 963758,
    "viewerRecords": 695,
    "runtimeHost": 0.307275846544565,
    "residualMs": 706458.7297021807,
    "residualPercent": 73.30250225701688
  }
]
```

Use the journal collector below with lo=11:27:27.000 and hi=12:31:11.902 UTC on the same day and revision; print summarise(a) and metrics(a). Both sensitivity quantities use the same definitions as the full cohort.


During the original measurement attempt, all direct production database
connections used SQLite URI `mode=ro`,
`PRAGMA query_only=ON`, a 0.25-second busy timeout and a short progress
deadline. No application store module was imported. Source searches and
direct stored-record searches replace APIs that refresh journals, write
receipts or normalize indexes. That attempt invoked no production route,
profiler, signal, restart, heap diagnostic or load generator.

The continuation read the required board tasks and used MCP transcript
search and conversation reads to recover the earlier answer. Transcript
search can start a leased query helper and write its helper record; the
exact side effect of these calls was not established. The bounded stored
helper inspection below found no retained transcript-search helper record
at **2026-11-11T13:25:37.098454Z**. No helper was stopped or record removed
manually. Subsequent investigation used stored files and source. The
continuation did not attach a profiler, change settings, restart a process
or collect the predecessor window again. The initial attempt's RTK command
accounting was also left intact.

```bash
python3 - <<'PY'
from pathlib import Path
from datetime import datetime, timezone
import json, time
root = Path.home() / '.config/delegatus/state/helpers'
deadline = time.monotonic() + 1
count, hits = 0, []
for p in root.glob('*.json'):
    count += 1
    if count > 500 or time.monotonic() > deadline:
        raise RuntimeError('helper inspection capped')
    if p.stat().st_size > 8192:
        continue
    value = json.loads(p.read_text())
    if 'transcript-search' in str(value.get('name', '')):
        hits.append({k: value.get(k) for k in ['name', 'pid', 'ownerPid', 'group']})
print('readUTC', datetime.now(timezone.utc).isoformat(),
      'inspected', count, 'searchHelperRecords', hits)
PY
```

The retained output is `inspected 4 searchHelperRecords []`. It proves
the absence of retained helper records at that read, with no assertion
about an earlier transient lease or index work.

<!-- evidence:start -->
Journal observation manifests. UTC fetch intervals, row counts, execution bounds and SHA-256 of the canonical parsed gap cohort are retained. The digest covers the deduplicated, UTC-sorted parsed gap records, serialized with sorted keys and compact separators, including their journal receipt times. Replay after journal retention may no longer reproduce it.

```json
{
  "steady": {
    "lo": "2026-11-11T11:27:27.000Z",
    "hi": "2026-11-11T12:37:23.816Z",
    "revision": "692e5338ea3fffa1d3e4110876387063bb7f3da9",
    "readStart": "2026-11-11T12:40:48.114Z",
    "readEnd": "2026-11-11T12:40:49.678Z",
    "fetch": [
      [
        "2026-11-11T11:25:27.000Z",
        "2026-11-11T11:40:27.000Z",
        1781
      ],
      [
        "2026-11-11T11:40:27.000Z",
        "2026-11-11T11:55:27.000Z",
        1548
      ],
      [
        "2026-11-11T11:55:27.000Z",
        "2026-11-11T12:10:27.000Z",
        1968
      ],
      [
        "2026-11-11T12:10:27.000Z",
        "2026-11-11T12:25:27.000Z",
        1212
      ],
      [
        "2026-11-11T12:25:27.000Z",
        "2026-11-11T12:39:23.816Z",
        1884
      ]
    ],
    "digest": "de4ef66e8ea0c7afc3cd2658b79c22acec0a2168a755525d35895f58cdd35094",
    "truncatedInWindow": [
      {
        "gapMs": 590,
        "pid": 3875509,
        "role": "viewer",
        "utc": "2026-11-11T11:59:48.084Z",
        "sequence": 493
      },
      {
        "gapMs": 536,
        "pid": 3875509,
        "role": "viewer",
        "utc": "2026-11-11T12:02:50.901Z",
        "sequence": 539
      }
    ]
  },
  "earlier": {
    "lo": "2026-11-11T08:17:30.184Z",
    "hi": "2026-11-11T09:27:27.000Z",
    "revision": "803f12c106a45833954c7df5a0c8533fa9253d09",
    "readStart": "2026-11-11T12:40:50.137Z",
    "readEnd": "2026-11-11T12:40:54.371Z",
    "fetch": [
      [
        "2026-11-11T08:15:30.184Z",
        "2026-11-11T08:30:30.184Z",
        9944
      ],
      [
        "2026-11-11T08:30:30.184Z",
        "2026-11-11T08:45:30.184Z",
        9000
      ],
      [
        "2026-11-11T08:45:30.184Z",
        "2026-11-11T09:00:30.184Z",
        7929
      ],
      [
        "2026-11-11T09:00:30.184Z",
        "2026-11-11T09:15:30.184Z",
        7784
      ],
      [
        "2026-11-11T09:15:30.184Z",
        "2026-11-11T09:29:27.000Z",
        8263
      ]
    ],
    "digest": "6fcce116389a0a9c4199e70f3436078429d8548978fef06e5809d221ab141137"
  }
}
```

Exact collector and allocation command used for these tables (run in the repository, without importing its application modules):

```bash
python3 - <<'PY'
import pathlib,subprocess,json,collections,datetime,time,statistics,re,hashlib
def ms(s):return int(datetime.datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()*1000)
def iso(t):return datetime.datetime.fromtimestamp(t/1000,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
def collect(lo,hi,revision):
 started=iso(time.time()*1000); records=[];aux=[];fetch=[];bad=[];sha=hashlib.sha256();cursor=lo-120000
 while cursor<hi+120000:
  stop=min(cursor+900000,hi+120000)
  cmd=['journalctl','--user','-u','delegatus.service','--since',iso(cursor),'--until',iso(stop),'--utc','-o','json','--all','--no-pager','-n','20000']
  q=subprocess.run(cmd,capture_output=True,text=True,timeout=18)
  lines=q.stdout.splitlines();assert q.returncode==0 and len(lines)<20000,(q.returncode,len(lines))
  fetch.append([iso(cursor),iso(stop),len(lines)])
  for line in lines:
   x=json.loads(line);m=x.get('MESSAGE') or '';jt=int(x['__REALTIME_TIMESTAMP'])/1000
   if m.startswith('[viewer loop-gap] '):
    try:v=json.loads(m[m.index('{'):])
    except ValueError:
     v={}
     for key in ['gapMs','pid','role','revision','utc','sequence']:
      found=re.search('"'+key+r'":("(?:[^"\\]|\\.)*"|[0-9.]+)',m)
      if found:v[key]=json.loads(found[1])
     bad.append([iso(jt),v])
    if v.get('revision')==revision and lo<=ms(v.get('utc','1970-01-01T00:00:00Z'))<hi:
     v['_journalMs']=jt;records.append(v)
   elif lo<=jt<hi:
    if True:
     aux.append([jt,m,int(x.get('_PID',0)),x.get('__CURSOR',line)])
  cursor=stop
 # Overlapping journal boundaries are deduplicated by the monitor's own sequence.
 gaps={ (v.get('role'),v.get('pid'),v.get('sequence'),v.get('utc')):v for v in records }
 records=sorted(gaps.values(),key=lambda v:v['utc'])
 return {'lo':iso(lo),'hi':iso(hi),'revision':revision,'readStart':started,'readEnd':iso(time.time()*1000),'fetch':fetch,'digest':hashlib.sha256(json.dumps(records,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'gaps':records,'aux':aux,'bad':bad}
def summarise(data):
 summary={}
 for role in ['viewer','runtime-host']:
  rows=[v for v in data['gaps'] if v['role']==role];g=[v['gapMs'] for v in rows];total=sum(g);named=sum(v.get('reads',{}).get('namedSyncMs',0) for v in rows)
  buckets=collections.Counter();ops=collections.Counter();topSum=0;allNamed=0;run=0;runGaps=0;triggers={};truncated=0
  for v in rows:
   r=v.get('reads',{});allNamed+=r.get('namedSyncMs',0)
   if not r:truncated+=1
   main=[x for x in r.get('top',[]) if not x.get('worker')]
   for x in main:
    name=x['reader'];family='registry' if name.startswith('registry.') else 'state' if name.startswith('state.') else 'memory' if name.startswith('memory.view.') else 'operation bodies' if name=='operation' else 'other'
    buckets[family]+=x.get('syncMs',0);topSum+=x.get('syncMs',0);ops[x['operation']]+=x.get('syncMs',0)
   s=v.get('scheduler',{})
   if s.get('runMs') is not None:run+=s['runMs'];runGaps+=v['gapMs']
   z=s.get('stall')
   if z:triggers[(v['pid'],z['sequence'])]=z
  buckets['named beyond top']+=max(0,allNamed-topSum)
  buckets['unattributed']+=sum(max(0,v['gapMs']-v.get('reads',{}).get('namedSyncMs',0)) for v in rows)
  a=sorted(g);coop=[v.get('cooperative',{}) for v in rows]
  summary[role]={'pids':sorted(set(v['pid'] for v in rows)),'n':len(g),'sumMs':total,'percent':total/(ms(data['hi'])-ms(data['lo']))*100,'p50':statistics.median(a) if a else None,'p95':a[int(.95*(len(a)-1))] if a else None,'max':max(a) if a else None,'longCount':sum(x>=1000 for x in g),'longMs':sum(x for x in g if x>=1000),'familiesMs':dict(buckets),'topOperationsMs':ops.most_common(8),'scheduler':{'runMs':run,'gapMs':runGaps,'distinctStalls':len(triggers),'unknownStalls':sum(x['site']=='unknown-runtime-or-native' for x in triggers.values())},'cooperative':{'n':sum(bool(x) for x in coop),'zero':sum(x.get('resumed')==0 for x in coop),'atMostTwo':sum(x.get('resumed',999)<=2 for x in coop),'maxDepth':max((x.get('maxDepth',0) for x in coop),default=0),'maxWaitMs':max((x.get('longestWaitMs',0) for x in coop),default=0)},'truncated':truncated,'gcStates':dict(collections.Counter(str(v.get('gc',{}).get('reason','unavailable-record')) for v in rows)),'logDroppedValues':sorted(set(v.get('logDropped',0) for v in rows)),'sequenceBounds':[min((v.get('sequence',0) for v in rows),default=0),max((v.get('sequence',0) for v in rows),default=0)],'missingSequences':[k for k in range(min((v.get('sequence',0) for v in rows),default=0),max((v.get('sequence',0) for v in rows),default=0)+1) if k not in set(v.get('sequence',0) for v in rows)],'rssMin':min((v.get('memoryUsage',{}).get('rss',float('inf')) for v in rows),default=0),'rssMax':max((v.get('memoryUsage',{}).get('rss',0) for v in rows),default=0)}
 return summary

def union_size(intervals):
 out=[]
 for a,b in sorted(intervals):
  if b<=a:continue
  if out and a<=out[-1][1]:out[-1][1]=max(out[-1][1],b)
  else:out.append([a,b])
 return sum(b-a for a,b in out)
def metrics(data):
 rows=[v for v in data['gaps'] if v['role']=='viewer']
 families=collections.Counter();ops=collections.Counter();readers=collections.Counter();sites=collections.Counter();sumUnion=0;sumNested=0;coalescedSlack=0;drop=0;records=[];triggers={};profiles=collections.Counter()
 aux=sorted({c:(t,m,p) for t,m,p,c in data['aux']}.values(),key=lambda x:x[0])
 holds=[];leases=[];waits=[];holders=[]
 for i,(t,m,p) in enumerate(aux):
  if 'holder=' in m:
   found=re.search(r'holder=([a-zA-Z0-9_.:-]+).*?pid=(\d+).*?age=(\d+)ms',m)
   if found:holders.append({'utc':iso(t),'holder':found[1],'pid':int(found[2]),'ageMs':int(found[3])})
  if m.startswith('[state transaction-hold]'):
   try:
    z=json.loads(m[m.index('{'):])
    if z.get('role')=='viewer':holds.append({'utc':iso(t),'heldMs':z['heldMs'],'collection':z.get('collection','unspecified'),'pid':z['pid']})
   except ValueError:pass
  elif m.startswith('[state lease-hold]'):
   body=m
   for tt,mm,pp in aux[i+1:i+7]:
    if pp!=p or tt-t>1000 or mm.startswith('['):break
    body+='\n'+mm
   op=re.search(r'operation:\s*"([^"]+)"',body);co=re.search(r'collection:\s*"([^"]+)"',body);held=re.search(r'heldMs:\s*([0-9.]+)',body)
   if op and held:leases.append({'utc':iso(t),'journalPid':p,'pid':None,'operation':op[1],'collection':co[1] if co else '?','heldMs':float(held[1])})
  elif m.startswith('[blocking-wait]'):
   try:
    z=json.loads(m[m.index('{'):])
    if z.get('role')=='viewer':waits.append({k:z.get(k) for k in ['site','durationMs','synchronous','at']})
   except ValueError:pass
 for z in leases:
  matching=[h for h in holds if abs(ms(h['utc'])-ms(z['utc']))<100 and abs(h['heldMs']-z['heldMs'])<100]
  if matching:z['pid']=matching[-1]['pid']
 for v in rows:
  g=v['gapMs'];r=v.get('reads',{});n=r.get('namedSyncMs',0);factor=min(1,g/n) if n else 1
  top=[x for x in r.get('top',[]) if not x.get('worker')]
  visible=sum(x.get('syncMs',0) for x in top)
  for x in top:
   name=x['reader'];family='Registry readers' if name.startswith('registry.') else 'State readers' if name.startswith('state.') else 'Role-memory readers' if name.startswith('memory.view.') else 'Operation bodies' if name=='operation' else 'Other named readers'
   families[family]+=factor*x.get('syncMs',0);ops[x['operation']]+=factor*x.get('syncMs',0);readers[name]+=factor*x.get('syncMs',0)
  families['Named beyond visible top']+=factor*max(0,n-visible)
  families['Unattributed']+=max(0,g-n)
  a,b=v.get('lastTick',0),v.get('tick',0)
  ss={x['sequence']:x for x in v.get('attribution',{}).get('slices',[]) if x['kind']=='sync'}
  intervals=[(max(a,x['start']),min(b,x['end'])) for x in ss.values()]
  u=union_size(intervals);nest=sum(max(0,e-s) for s,e in intervals)
  sumUnion+=u;sumNested+=nest
  coalescedSlack+=sum(max(0,x['end']-x['start']-x['totalMs']) for x in ss.values() if x['count']>1)
  drop+=r.get('droppedMs',0)
  s=v.get('scheduler',{});z=s.get('stall')
  if z:triggers[(v['pid'],z['sequence'])]=z
  for x in s.get('sites',[]):sites[x['site']]+=x['samples']
  q=v.get('jsProfile',{});profiles[(q.get('status','absent'),q.get('reason',''))]+=1
  if g>=1000:
   top=sorted(top,key=lambda x:x['syncMs'],reverse=True)
   # Hold timestamps are journal delivery times, so this is contextual proximity.
   near=[f"T{j+1}" for j,x in enumerate(holds) if ms(v['utc'])-g-1000 <= ms(x['utc']) <= ms(v['utc'])+1000]
   near += [f"L{j+1}" for j,x in enumerate(leases) if x['pid'] in [v['pid'],None] and ms(v['utc'])-g-1000<=ms(x['utc'])<=ms(v['utc'])+1000]
   records.append({'utc':v['utc'],'sequence':v.get('sequence'),'gap':g,'named':min(g,n),'unknown':max(0,g-n),'union':u,'maxSpan':max((x['maxMs'] for x in ss.values()),default=0),'top':[[x['operation'],x['reader'],x['syncMs']] for x in top[:3]],'topOthers':max(0,len(top)-3),'cooperative':v.get('cooperative'),'runMs':s.get('runMs'),'holds':near,'stall':z['sequence'] if z else None})
 return {'familiesMs':dict(families),'opsMs':ops.most_common(),'readersMs':readers.most_common(),'unionMs':sumUnion,'nestedMs':sumNested,'coalescedSlackMs':coalescedSlack,'droppedReaderMs':drop,'schedulerSites':sites,'distinctStalls':len(triggers),'unknownStalls':sum(x['site']=='unknown-runtime-or-native' for x in triggers.values()),'profiles':[[list(k),v] for k,v in profiles.items()],'records':records,'holds':holds,'leases':leases,'waits':waits,'holders':holders}

lo=ms('2026-11-11T11:27:27.000Z');hi=ms('2026-11-11T12:37:23.816Z')
a=collect(lo,hi,'692e5338ea3fffa1d3e4110876387063bb7f3da9')
b=collect(ms('2026-11-11T08:17:30.184Z'),ms('2026-11-11T09:27:27.000Z'),'803f12c106a45833954c7df5a0c8533fa9253d09')
for name,rows in [('steady',a),('earlier',b)]:
 print(name,json.dumps(summarise(rows)))
print('allocation',json.dumps(metrics(a)))
PY
```

<!-- evidence:end -->
