# Seat tick panel API handoff

The backend stage implements A1–A3 and the API contract for the status block
and maintainer model picker. The following UI stage continues on the same
branch and pull request with B1–B7, including rendered checks in both locales,
themes and viewport sizes.

## Status data

`GET /api/monitor/seat-tick/settings?project=<project>` returns the existing
`SeatTickSettingsAnswer`. Its `effective`, `policy`, `state`, `lastRun` and
`lastDelivery` fields supply the wake schedule, last check, next-wake estimate
and blockers. Reuse `src/components/orchestrator/seatTickView.ts` for those
readings. `lastDelivery` belongs in Details.

`maintenance` carries the independent maintenance switch and interval, `live`,
`lastRun` (including `counts`, `attentionCount`, `taskId` and account failure),
`nextEligibleAt`, `nextRunAt`, `waitingOn`, and `runsError`. Link the attention
count to `lastRun.taskId`. A `no-account` failure supports the Accounts remedy.
Estimates are null while a seat or deployment blocks a launch, or the run store
could not be read.

A1 adds `waitingOn: "wakes-off"` and
`pauseReason: "paused while wakes are off"`. Both next-run timestamps are null
while wakes are off. The saved maintenance switch and the last result stay
available. A run already launched can still be reconciled to its result;
turning wakes off pauses new dispatches and recovered launch retries.
An existing live run remains `waitingOn: "live-run"` and carries the pause
reason alongside it. Use `waitingOn` and `pauseReason` to render localized
panel text in English and Ukrainian. The pinned A1 requirement supersedes the
critique's earlier suggestion to run maintenance while wakes are off.

`PUT /api/monitor/seat-tick/settings` already accepts tick and maintenance
changes in one body. `seat_tick_settings` reports the same pause and result
data. Its verbose read adds `lastRunLog`.

## Maintainer picker

`GET /api/roles` now includes `launchChoices`:

```ts
Array<{
  engine: "claude" | "codex";
  models: Array<{
    id: string;
    label: string;
    shortLabel: string;
    use: string;
    efforts: readonly string[];
  }>;
}>
```

Read the current config from `roles.find(role => role.id === "maintainer")`.
Choose only engine, model and effort combinations in `launchChoices`. The
catalogue is derived from the existing launch model list and per-model effort
scales. It includes both engines supported by the role registry.

Write through the existing endpoint:

```json
{
  "expectedRevision": "<revision from the roles response>",
  "overrides": {
    "maintainer": {
      "config": {
        "engine": "codex",
        "model": "gpt-6.1-sol",
        "effort": "medium"
      }
    }
  }
}
```

This edits the same row as Settings → agent mapping and `role_presets`.
Unrelated rows and prompt overrides survive. The PUT response is the merged
catalogue; HTTP 409 returns the current catalogue when the revision changed.
Invalid engines, models and efforts are refused before storage. There is no
second project-specific maintainer config. Tick settings and role mappings are
separate writes, so the panel's single Save must preserve the remaining draft
and report a failed write if only one request succeeds.

## Backend behavior and A3 cause

The maintainer prompt keeps work assigned while its pull request is open or
the orchestrator seat still carries its release/deployment. A retired seat's
own card becomes done and hidden history after checking the current and pending
seats. The guard permits that narrow hide, resolves seat identity aliases and
preserves assignments, transcripts and details. Ordinary work cards remain
protected from maintenance hides.

The first production run's refusal came from a historical assignment whose
activity was `gone / launch_unproven_expired`, with `turnState: "idle"`,
`host.state: "unknown"` and `evidenceSource: "transcript"`. The guard separately
treated any unknown host as live. Conversely, it allowed a live idle host.
It now consumes the same lifecycle projection as `agent_activity` and permits
closure only for `gone` with an idle turn confirmed by a fresh transcript read.
Missing identities, unreadable tails, budget projections and open/severed turns
remain refusals. Open pipelines and assignments added during the read are
checked again at the task mutation boundary.

Regression tests exercise the production transcript reader and MCP service
in both directions, including the expired historical assignment and a verified
live idle owner. Additional cases cover path-only assignments, unknown evidence,
the wake pause, claim recovery, HTTP/MCP parity, seat history hides, and every
offered maintainer model/effort choice.
