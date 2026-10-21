# Subscription API consent

## CLI observation, 2026-10-21

Observed before implementation, at base `3e6ca3c1`, using the installed
Claude Code 2.1.302 executable. The probe used a fresh empty HOME, config,
working directory and state directory under the stage scratch root. It removed
Anthropic and Claude environment variables. No account credentials were read.

- `claude --version`: `2.1.302 (Claude Code)`.
- `claude --help`: print mode, `--output-format json|stream-json`,
  `--json-schema`, `--tools ""`, `--strict-mcp-config`, `--setting-sources`,
  `--safe-mode` and `--no-session-persistence` are supported. There is no
  top-level `usage` subcommand.
- `claude -p /usage --output-format json --tools "" --strict-mcp-config
  --mcp-config '{"mcpServers":{}}' --setting-sources ''
  --no-session-persistence`: exit 0, `type: result`, `subtype: success`,
  `local_command: usage`, `is_error: false`, `num_turns: 0`, zero input/output
  tokens. `result` contains cost, duration, code-change and token totals.
  An unauthenticated invocation returns no subscription windows.

Inspection of that installed executable's embedded command and output schemas
established the subscription path without making an authenticated request:

- `/usage` declares `supportsNonInteractive: true`. Its synthetic assistant
  record carries `usage_report` (persisted transcripts spell it `usageReport`).
  `rate_limits.limits[]` rows have `kind` (`session`, `weekly_all`,
  `weekly_scoped`), `group`, `percent`, nullable ISO `resets_at`, and optional
  `scope.model.display_name`. The CLI validates this report before emitting it.
- Stream records include `type: rate_limit_event`, `rate_limit_info` with
  `status`, optional `rateLimitType`, `utilization`, `resetsAt` and
  `unifiedWindows`. Utilization is a fraction; resets are epoch seconds.
- Statusline input includes `rate_limits.five_hour` and `seven_day`, with
  `used_percentage` and epoch-seconds `resets_at`. The installed implementation
  emits them conditionally. The [official statusline reference](https://code.claude.com/docs/en/statusline)
  documents these fields. Statusline delivery belongs to interactive sessions;
  a configured statusline is unnecessary for a print-mode usage read.

The unauthenticated probe establishes command support and the no-window result.
Subscription output shapes above were observed in the installed schemas;
live subscription output was deliberately not requested. On this base the
transcript limit reader in `src/lib/limits.ts` is for Codex. There is no Claude
transcript-limit reader to reuse.

## Contract inventory

`prepareJsonCaller` selects a Claude subscription account through
`AccountManager.resolveHeadlessSpawn`. Its consumers are the profile caller
(`profileService.ts`) and voice summaries (`voiceCompanion/callMemory.ts`).
The profile service validates schema, language and content before writing
`profileStore.ts`; voice summaries use `boundedSummary` before storage.
The memory model defaults and Opus-to-Haiku fallback stay in `profileModel.ts`.
The optional browser timing case also calls the profile caller.

`fetchClaudeLimits` serves both the account manager and the shared limits cache;
the quota controller uses `readClaudeAccountLimits`. Consent must be checked
inside the direct endpoint function, including callers bypassing the cache.
The separate installation consent file is created exclusively by
`subscriptionApiConsent` and updated by the operator settings route through
`setSubscriptionApiConsent`. Its readers are that route's GET, the limits cache
loader and the direct usage dispatch check. It has no per-project copies or
cascading account defaults. The cache loader initializes consent before it can
upgrade an older parser marker, including when a Codex cache write comes first.
Creation follows the existing startup mutation guard; other process kinds read
the choice the Viewer initialized. A refused migration does not turn into an
empty cache that could overwrite its proof of prior use.
New installations persist false before the first endpoint attempt. Successful
historical Claude OAuth readings in `limits-cache.json` prove prior use for
migration; an explicit choice always wins and corrupt consent fails closed.

Claude Code may answer `/usage` from its own cached usage snapshot. Delegatus
records when it read the CLI report; the CLI manages the cache and its provider
requests. An unrecognized or empty report stays unavailable.

The headless launcher's memory planner reads `liveStructuredHostCount` through
the registry's existing active-status index. It counts the same four active
structured-host states as the previous snapshot scan, excludes retained dead
and unhosted rows, and does not change host writers or the memory policy.
