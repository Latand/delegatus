# Codex subscription voice: slice 1 verification

This implements slice 1 of [the design](../design/voice-codex-subscription.md).
The design is copied unchanged from its design branch. The Codex provider is
selected only by `LLV_VOICE_BACKEND=codex`; there is no new UI control.

## Acceptance evidence

1. **SDP and refusal lifetime.** `codexProvider.test.ts` starts a real stdio
   stub through the helper lease. An RPC acknowledgement leaves start pending
   until `thread/realtime/sdp`. A pre-SDP error rejects start and the recorded
   stub PID has exited. The limit variant reads the same client's account
   window, records the observation and returns its reset time.
   A close timeout before SDP followed by a late answer also rejects start,
   reaps the stub and clears its stored open flag. Recovery stops a call still
   held by the same provider; a refused hangup keeps the open flag until a
   later recovery confirms cleanup. An error immediately after SDP in the
   same stdout chunk rejects start and reaps the stub too.
   The reap-deadline regression holds stdout in an owned descendant outside
   the app-server's process group for longer than five seconds. Before the
   fix, recovery still stored `remoteOpen: true` after both processes exited.
   Hangup now discards a rejected stop promise while keeping the call closed
   to attachment and tools. A later recovery confirms reaping, removes the
   scratch directory, stores `remoteOpen: false` and admits a new start.
   Closed notifications, event-queue overflow and disposal also handle their
   background hangup rejections. The deadline still starts after the stop RPC
   and transport close, and its timer is cleared when reaping settles.
2. **Registry and read ledger.** Two `item/tool/call` requests for `list_tasks`
   in separate backing turns produce one store read. The second result has
   `repeated: true` and `readSecondsAgo: 0`, through the existing 120-second
   ledger. The fixture also calls `end_conversation` through the registry and
   observes its tool reply followed by closure with reason `tool`.
3. **Subscription and account fences.** The stub records environment variable
   names and finds zero `*_API_KEY` variables. API-key authentication returns
   `CODEX_AUTH_REQUIRED`. Capacity and project-binding tests select only
   signed-in managed accounts; an exhausted managed pool returns
   `CODEX_LIMIT_REACHED` with its earliest reset and never selects the signed-in
   legacy account. A legacy-only pool returns `NO_CODEX_ACCOUNT`. The session
   starts with a zero USD cap and an API-key accessor that throws if called.
4. **Viewer lifetime.** A fixture Viewer starts the provider, records both
   process IDs, then is killed by its recorded PID. The app-server exits and
   its helper-lease record disappears. Ordinary close and refused start also
   leave no stub process alive.
5. **Installed protocol.** `codexVoiceSchema.test.ts` generates experimental
   JSON schemas from the installed Codex executable in an isolated home. It
   checks initialization, account read, both thread-start configurations,
   realtime start/stop/appendSpeech and dynamic-tool responses, rejecting a
   deliberately unsupported field in every case. The installed canary version
   was `codex-cli 0.162.1`; the test runtime was Bun `1.4.0`.
   On machines without Codex the installed-schema test skips; the acceptance
   check requires an installed executable and passes against it here.
6. **Live board answer.** The canary uses a copied managed sign-in in isolated
   homes, the production task/pipeline stores and
   `createCompanionBoardReadPaths` through `CompanionLiveSessions`. The spoken
   question asks for open tasks and active pipelines. Both configurations
   correctly name the fixture's two open tasks and its one running pipeline.
   The measurement table below records the comparison.

The failing-first observations included ignored custom app-server arguments,
the absent Codex provider, the USD-cap refusal on a subscription session and
the HTTP refusal codes being collapsed to `COMPANION_UNAVAILABLE`. A separate
transport regression test first reproduced a tool response written after
stdin closed; the client now fences that write.
Review regressions first reproduced the late-start process leak, premature
recovery closure, the dropped error following SDP, and recovery of an old API
call through a Codex no-op. Old API calls now use the API provider for recovery
even when new calls use Codex, and remain open until hangup is confirmed.

## Live measurements

The reference design probe measured 15,841 input tokens and 5.19 seconds from
handoff to answer audio. These measurements use the first backing request's
`inputTokens` and time from the handoff notification to the first received
answer PCM above the silence threshold. A greeting precedes the board question.
The canary disables acknowledgement filler for measurement, as the reference
probe did; production retains Codex's default filler.

| Configuration | First input tokens | Handoff → answer audio |
| --- | ---: | ---: |
| Design probe | 15,841 | 5.19 s |
| Codex default, sample 1 | 14,742 | 6.12 s |
| `environments: []` + `baseInstructions`, sample 1 | 11,380 | 3.87 s |
| Codex default, sample 2 | 14,739 | 3.31 s |
| `environments: []` + `baseInstructions`, sample 2 | 11,383 | 4.38 s |
| Codex default, mean of two calls | 14,740.5 | 4.71 s |
| Compact configuration, mean of two calls | 11,381.5 | 4.12 s |

The provider keeps `environments: []` and `baseInstructions`: the compact
configuration answered the same fixture correctly with fewer input tokens and
lower mean measured latency. Each configuration won one latency sample. This
small canary compares configurations; it does not estimate a general latency
distribution.

Each call records its Viewer stand-in, lease guardian and app-server PIDs in
private evidence. Cleanup stops only those owned processes. New account
session files and surviving helpers are both zero across all four calls. The
repeat queries `mcpServerStatus/list` before thread creation and after the board
answer: all four inventories contain zero servers. The isolated Codex logs
contain zero `codex_apps` start/spawn events. Raw SDP, account material, logs and
PID ledgers remain outside the public repository.

## Checks and scope

Tests run by explicit file path through `scripts/gate-slot.sh`, with `HOME`,
XDG configuration, `TMPDIR` and `LLV_STATE_DIR` under one private temporary
root, and `LLV_VIEWER_CONTROL_URL` set to a closed loopback port. TypeScript,
changed-file ESLint and the local publication privacy gate use the project's
gates. The initial ten explicit test files covered 363 tests. The hangup fix's
focused provider file passes all 13 tests, including three new cases that
cross the real five-second reap deadline; the final pre-push gate
also compares touched files against the merge base. No runtime-host source
changes are part of this slice.

The provider imports neither `codexRealtimeTranscript.ts` nor
`CodexAppServerHost`. Transcript adaptation, spoken confirmation, sends,
reports, context updates and transcript-based hang-up admission are slice 2.
Plan-window UI, mid-call limit handling and selecting Codex by default are
slice 3. The existing API provider remains the default until then.
