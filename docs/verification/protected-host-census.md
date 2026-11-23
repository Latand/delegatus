The observation before editing used main `c5c7c372e47f5aa1ff89509a15acac8cc96330be`.
The diagnostic census at 2026-11-04 09:21:30Z classified the omissions as follows.
Line references in this first table refer to that main revision.

| Observed kind | Physical hosts | Counter contributions | Cause |
| --- | ---: | ---: | --- |
| Codex structured host, absent transcript in the default session home | 2 | 4 undescribed | A missing artifact enters the missing-path set at `scripts/protected-host-census.ts:159` and the unrepresented-owner list at `:173`; `:187` adds both. |
| Codex structured host, absent transcript in a managed account home | 2 | 4 undescribed | The same double count. The files are absent at their recorded paths; native session and archive directories also contain no matching artifact. |
| Codex structured host, readable older generation with a different live PID | 1 | 1 undescribed, 1 unselected | `src/lib/lifecycle/liveness.ts:1485` folds generations into one conversation; `:1496` lowers selected. The census checks represented PIDs at `scripts/protected-host-census.ts:172` and subtracts selected from raw matched at `:186`. |
| Duplicate registry records naming one live process | 1 duplicated process | Inflates owners by 1 | `scripts/protected-host-census.ts:143` counts records without deduplicating their process. This process was already represented, so it contributes no undescribed host. |

Thus nine undescribed contributions describe five omitted physical hosts in
this diagnostic. All five are Codex structured hosts. No omitted Copilot,
relay, headless or seat host was observed. Account roots are not omitted by a
directory scan: this census calls the native describer directly on each
recorded artifact and injects its root (`scripts/protected-host-census.ts:113`).

The supplied 08:59:12Z sample reported ten undescribed contributions and two
conversations with multiple live owners. It retained totals and selected rows,
but no omitted-owner identities or registry snapshot. The later diagnostic
reports nine contributions and one such conversation. The original tenth
contribution cannot be identified retrospectively from those retained
artifacts. This report does not assign it a guessed engine or role.

Two separate starting receipts in the live registry named the Viewer as their
admission owner and had no artifact. These are setup custody. A real launched
host without an artifact remains an incomplete capture.

The four absent transcript files are an evidence gap. A live process identity
does not supply native turn evidence. The census continues to refuse a complete
capture for those hosts; this change creates no replacement transcript and
changes no live record.

The fixtures and fix

`scripts/protected-host-census.test.ts` reproduces the older structured host,
missing default/account artifacts, duplicate owner records and setup custody.
It also exercises the older-generation path for tmux, receipt and headless
owners. Native structured, tmux, receipt and headless equivalence, real history
references, pending history, byte-preserving reads, missing schema, unreadable
evidence, deadline exhaustion and the 200-owner cap remain covered.

The census retains the production inventory and supplements an omitted live
owner through the production targeted liveness reader. That read uses only the
owner's recorded artifact and process in a request-local registry view, while
retaining its durable conversation ID for pipeline lookup. Physical owners
are deduplicated by PID, selection counts capture targets, and an unrepresented
host is counted once. The supplementary read shares the capture deadline and
the 200-row limit. Unreadable or projected evidence still refuses capture.

`scripts/deploy-checkout.py`, its parser, `complete_activity()`, host identity
checks and deployment operations are unchanged. The new missing-artifact test
passes the actual census result to the existing Python guard and requires its
incompleteness refusal.

All eight new regression cases fail on unmodified main (zero pass, eight fail,
eleven existing cases filtered out). The fixed source passes all nineteen
census tests, with 109 assertions. Runs use fresh isolated state through the
gate, one explicit test file per owned command.

Observation method

Both observations run source exports, with explicit isolated HOME, configuration,
temporary and state directories, no state-owner claim, and the Viewer control
URL on a closed loopback port. SQLite is opened read-only; `VACUUM INTO` creates
each state copy beneath an automatically allocated OS temporary directory.
The registry and recorded native transcript paths are read from the live
installation. No Viewer API supplies the census and no live state is written.
The gate command runs locally through `scripts/gate-slot.sh`, with no custody
handoff. Its admission wait is separate from census wall time.

| Source and observed UTC | Owners | Matched | Selected | Unselected | Undescribed | Census wall time | Load average, 1/5/15 min |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Unmodified main, 09:14:32 | 126 | 121 | 120 | 1 | 9 | 7.206 s | 14.85 / 15.28 / 17.82 |
| Main with diagnostic output only, 09:21:30 | 127 | 122 | 121 | 1 | 9 | 6.554 s | 56.67 / 50.31 / 34.39 |
| Fixed census, fresh state copy, 09:38:05 | 123 | 119 | 119 | 0 | 4 | 5.613 s | 10.42 / 19.67 / 24.75 |

Both main runs reported zero unreadable, projected and recovery-pending rows.
The fixed run also reported zero unreadable, projected and recovery-pending
rows, with a complete evidence budget. Its four remaining omissions are
genuinely absent recorded artifacts, so the unchanged guard still refuses
deployment. The SHA-256 of the fresh state copy was identical before and after
the census. Peak census RSS was 1,001,384 KiB.

Different owner counts and loads reflect a changing live fleet. These are
coverage observations and support no performance improvement claim.
