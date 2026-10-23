# Read-only onboarding diagnostics: first slice

The 2026-10-21 scope decision calls for shared read-only diagnostics in onboarding
and a thin CLI command. This slice supplies the shared registry, a standalone
command, and the onboarding read API. The original doctor design predates
structured agent transport; its tmux checks no longer apply.

## Use

```sh
delegatus doctor
delegatus doctor --json
delegatus doctor --port 8898
```

Human output follows the CLI language setting. JSON has `schemaVersion: 1`,
`generatedAt`, platform information, and an ordered `capabilities` array.
Each row has a stable ID, state, reason, probe timestamp, duration and timeout
flag. Exit 0 means no blocked prerequisite, 1 means at least one is blocked,
and 2 means invalid arguments or a failure of the command itself. Unknown
results remain advisory; exit 0 does not promise a successful agent launch.

`GET /api/onboarding/diagnostics` returns the same registry for an explicit
onboarding refresh or an authenticated API caller. The existing proxy applies
the installation's team/access-key perimeter; `rejectCrossOrigin` also checks
Host, Origin and fetch metadata for both GET and HEAD. Query parameters cannot
select a directory or network target. Responses use `Cache-Control: no-store`.
There is no cache, polling, startup instrumentation or background work.

## What the rows prove

| ID | Observation | Limit |
| --- | --- | --- |
| `engine.claude`, `engine.codex` | Executable file presence in the launcher's candidate order, including container shims and the Codex binary override | No executable is run; no launch or login is verified |
| `auth.codex` | A nonempty readable credential file at the source used by the transcription auth reader | Contents are never read; validity, expiry and managed account selection remain untested |
| `transcripts.claude`, `transcripts.codex` | The default transcript directory exists and is readable | Individual transcripts and additional account roots are untested; a missing root is degraded |
| `transcription.local` | The configured or legacy-fallback Whisper environment has an executable Python | Present Python is degraded with `WHISPER_RUNTIME_UNCHECKED`; neither the package nor model is loaded |
| `viewer.server` | A HEAD request recognizes this version's diagnostics endpoint | Older versions and unrelated listeners are unknown; a protected listener is degraded until access is verified |

`bin/doctor.mjs` owns the probes. `bin/doctor-command.mjs` formats their report
and parses CLI options. `src/lib/doctor/contracts.ts` supplies the shared types.
The route imports the same implementation. The package already includes `bin`,
so the command needs no TypeScript sources, dependencies or running Viewer.
CLI dispatch precedes launcher custody, release selection and startup.

Probes use asynchronous filesystem metadata reads and one credential-free,
loopback-only HEAD request. They never read credentials, execute subprocesses,
install packages, download models, change login state, restart services or
write configuration. Remediation sentences are static. Reports contain no
paths, environment values, file contents or raw errors. Redirects are refused.
Each probe has a 1.5-second deadline; all seven start concurrently. A timed-out
filesystem read can finish later, but starts no subsequent reads. Binary
candidate lists and search-path length are bounded. No performance gain is
claimed.

## Deferred

The onboarding panel and action gating consume this API in a later slice.
The existing paid onboarding health run stays separate: even its GET path can
sweep leftover runs, so this read-only command never calls it. Packaged
transcription bootstrap, Python/package/model execution checks, additional
engine auth sources, cloud transcription configuration, runtime version checks
and platform package-manager guidance also remain deferred. Existing launch
preflight and history reads keep their current behavior.
