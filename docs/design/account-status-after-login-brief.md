# Account status after a successful login: brief

## Originating requirement

Operator, 2026-10-12 ~05:50 (in Russian), with a screenshot of the «Акаунти Claude» sheet:

> «Вот такой вот баг после входа в аккаунт: не обновляется его статус. Надо нажимать на «Обновить», чтобы оно обновилось.»

("Here's a bug after logging into an account: its status doesn't update. You have to press «Обновить» [Refresh] to make it update.")

The screenshot shows the account «Main» (id `default`) after login with «Помилка входу»
(`accounts.auth.error`) and «поки немає даних» (`limits.noDataYet`), plus the «Оновити»
(`accounts.refreshLimits`) and «Повторити» (`accounts.retry`) buttons. After a manual «Оновити»
the data appeared (weekly 1%, plan max, observed 05:49:43Z).

Pinned acceptance, summarised:

- When a login completes successfully (Claude, and Codex/Copilot if they share the flow), the
  account's login state and its limits are re-read immediately. The sheet card and the sidebar
  footer update with no manual «Оновити» and no reopening, on desktop and on the phone.
- A failed login still shows its error, and once a later login succeeds, no «Помилка входу» from
  an earlier attempt stays on the card.
- The cause is found and fixed at its source.
- Tests cover three cases with fixtures only: success leads to an immediate refresh, failure keeps
  the error, and a later success clears an old error.
- Rendered evidence of before and after, at 1440 and 390 px, in uk and en, light and dark, from
  the existing drivers.

## The cause

Three separate gaps combine. Each one alone is enough to leave the card stale.

### 1. Login completion records nothing about the account (server, the source)

`GET /api/accounts` takes each card's auth badge and limits only from the registry's durable
quota observation (`src/app/api/accounts/route.ts:175` for Claude and `:144` for Codex, the `accountProjection(...)` spread;
`src/lib/accounts/accountProjection.ts:51-90`). The login does not write that observation:

- Claude: `ClaudeLoginSupervisor.reconcileExit` (`src/lib/accounts/claudeLogin.ts:614-636`) runs
  `ports.status(home)` and then `finish(id, "authenticated", …)` (`:638-642`). `finish` updates
  the operation and releases the child, and nothing else. The supervisor has just proved the
  account is signed in, and it throws that fact away.
- Codex: the `account/login/completed` handler (`src/lib/accounts/codexRuntime.ts:221-224`) calls
  `settle(attempt, "completed", …)` (`:446-453`), which only writes the attempt record.

So the observation from before the login stays on the card. For Main in the screenshot it is the
controller's own pre-login read. `claudeQuotaObservation` records an `authenticated: false`
observation with `source: "unavailable"` when `claude auth status` says signed out
(`src/lib/accounts/migration/quotaController.ts:136-146`). `accountProjection` renders that as
`error` (`accountProjection.ts:57-59`, a non-`live` source), which is «Помилка входу». The
observation stays "current" for `AUTO_BALANCE_FRESH_MS` = 5 min (`quotaPolicy.ts:11`), and the
projection keeps showing it.

### 2. The limits cache holds the pre-login failure, and the controller re-records the error from it (server, cached error state)

The background controller does not repair this on its next minute. A limits read that failed
before the login (credentials missing, 401) is kept in the shared limits cache with
`retryAt = now + FAILURE_COOLDOWN_MS` (60 s), and up to 15 min after 429s
(`src/lib/limits.ts:43-44`, `resolveRead` `:295-362`, `cacheIsFresh` `:371-375`). A non-forced
read returns that cached failure until `retryAt` (`resolveEngineRead` `:394-421`). After the
login:

1. The controller's tick probes Main. `claude auth status` now says signed in, and
   `readClaudeAccountLimits` without `force` returns the cached failure, so it gets
   `authenticated: true` with `limits: null` (`quotaController.ts:147-156`).
2. The tick treats an authenticated read without limits as a failed read and calls
   `carryForward` (`quotaController.ts:332-334`).
3. With no previous limits, `carryForward` records `authenticated: false`, `source: "unavailable"`
   (`:266-277`). That is the same «Помилка входу», now written again with a fresh timestamp.

This lasts until the cached failure's `retryAt` passes. The manual «Оновити» works because
`POST /api/accounts/claude/limits` (`src/app/api/accounts/limitsRefresh.ts`) calls
`refreshAccountLimits` with `force: true` (`src/lib/accounts/liveLimits.ts:71-82`). That skips
the cache and backoff, reads live, and records an `authenticated: true`, `source: "live"`
observation, which is exactly what the operator saw.

### 3. The client stops reading the moment the login ends (client, missing event)

All account surfaces of an engine share one store (`src/hooks/useEngineAccounts.ts`,
`createEngineAccountsStore`). It polls `/api/accounts` only while a login is live:

- `desiredIntervalMs` (`useEngineAccounts.ts:694-702`) returns 2 500 ms while a Claude operation
  is nonterminal, 10 000 ms while a Codex `loginPending` or a draining migration exists, and
  `null` otherwise.
- The poll that first reads `phase: "authenticated"` turns the row non-pending.
  `updatePolling` (`:703-713`) then stops the interval, so that read is the last one.
- Nothing reads again afterwards. `subscribe` re-reads only while `status === "loading"`
  (`:1216-1219`). The limits footer keeps the singleton store subscribed, so reopening the sheet
  does not re-read either. The only later reads come from a mutation or a page reload.

Because of gaps 1 and 2, that last read carries the pre-login observation. The card then stays
frozen on it:

- `AuthIdentity` renders the `error` badge (`src/components/AccountsPanel.tsx:307-317`).
- `AccountLimitsBlock` renders «поки немає даних» (`:176`).
- `ClaudeLoginRow` falls through to its "stranded in error" branch and offers «Повторити»
  (`:671-689`), even though the login it just watched succeeded.

That is the screenshot exactly.

### The scratch reproduction

The client half was run against the real store (`createEngineAccountsStore("claude")`) with a
fake fetcher, from a `git archive` export of the base commit in the stage's scratch directory,
with no product edit (`bun test`, 1 pass, 8.8 s). The first read gave
`verifying` plus an `error` observation, and the second gave `authenticated` plus the same
observation. After the authenticated read, the row kept `authHealth: "error"`, `limits: null`,
and the store made no further `/api/accounts` request over the next 6 s.

## The change

The principle: a successful login is itself the moment to read the account again. Run the same
forced live read «Оновити» runs, at the place where the login completes, before the completion
is published. The poll that first shows the login as done then already carries the new badge and
limits. Every reader benefits: the sheet, the footer, the phone, another tab, and the spawn
gate's capacity check.

### Server (the fix)

1. **One shared step:** `refreshAccountLimits(engine, accountId, { phase: "login-complete" })` from
   `src/lib/accounts/liveLimits.ts`. Add `"login-complete"` to `LiveReadPhase` (`liveLimits.ts:28`)
   and to the `probePhase` union in `src/lib/events.ts:75`, so the quota telemetry names the
   reader. The step runs the provider read with `force: true`, which also replaces the cached
   pre-login failure. The controller's next tick then reads live data from the cache and does not
   re-record the error (gap 2).

2. **Claude:** `src/lib/accounts/claudeLogin.ts`.
   - Add a port `observeSignedIn(accountId: string): Promise<void>` to `ClaudeLoginPorts`
     (`:59-73`). `realClaudeLoginPorts` implements it with a dynamic
     `await import("@/lib/accounts/liveLimits")`, because `liveLimits → quotaController →
     claudeLogin` is an import cycle. Test ports pass a fake.
   - In `reconcileExit` (`:614-636`), when `status.loggedIn && credentialsSafe` and the operation
     has an `accountId`, await `observeSignedIn` while the phase is still `verifying`. Then
     re-check that the operation is still `verifying` and call `finish(…, "authenticated", …)` as
     today. The client keeps fast-polling through `verifying`, and its first `authenticated` read
     includes the fresh observation.
   - The read is bounded by `PROBE_TIMEOUT_MS` (15 s) inside `refreshAccountLimits`. A
     `probe_failed` result or a throw must not change the login outcome: log it, then finish
     `authenticated`.
   - Clear the operation's deadline timer once the status read has proved the login
     (`this.timers`, `:486`, `:551-555`). Otherwise a login that completes in the last seconds of
     `LOGIN_TIMEOUT_MS` could be turned into `timed_out` by `timeout()` (`:600-612`) during the
     extra read.
   - The `failed`, `canceled` and `timed_out` paths do not call the port.

3. **Codex:** `src/lib/accounts/codexRuntime.ts`.
   - Add the same `observeSignedIn` to `ManagedCodexRuntimeOptions` (constructor `:157-162`). The
     default lazily imports `liveLimits` the same way.
   - In the `account/login/completed` handler (`:221-224`), when `success` is true, run
     `observeSignedIn(attempt.accountId)` first. Then, only if `this.owns(attempt)` still holds
     (a cancel or a newer attempt may have taken over), call
     `settle(attempt, "completed", null, true)`. A read failure still settles `completed`.
     `success: false` settles `failed` at once, as today. `loginPending` stays true until the
     read lands, so the 10 s poll that first shows the login done also shows the account
     authenticated.

### Client (one small addition)

In `refresh()` (`useEngineAccounts.ts:719-752`), when the new read shows that a login this store
watched has finished successfully, bump `limitsVersion`:

- Claude: an operation that was nonterminal in the previous snapshot now reads `authenticated`.
- Codex: a row that was `loginPending` now reads not pending, with `loginState` `completed` or
  `authenticated`.

`LimitsFooter` already reloads `/api/limits` on that bump (`src/components/LimitsFooter.tsx:300-308`),
so the sidebar footer catches up at the same moment as the card. This is the existing pattern
`refreshLimits` uses (`useEngineAccounts.ts:1121`). There is no new polling and no new state.

### Copilot

Copilot has no sign-in flow in the accounts sheet. `src/app/api/accounts/copilot` serves only
`models`, and `copilotLaunchSection` reads sign-in from the CLI's own files
(`route.ts:27-33`). It does not share the flow, so it is out of scope.

## Tests

All fixtures use neutral ids and labels (`default`/`Main`, `one`, `Account B`). There are no
real homes, tokens or e-mail addresses, and no UUID-shaped strings. Run each file by path through
`bash scripts/gate-slot.sh bun test <file>` with an isolated `HOME`, `XDG_CONFIG_HOME`,
`TMPDIR`, `CLAUDE_CODE_TMPDIR` and `LLV_STATE_DIR`.

| File | Case |
|---|---|
| `src/lib/accounts/claudeLogin.test.ts` | Child exits and status says signed in, so `observeSignedIn("one")` is awaited before the operation reads `authenticated`. Every `get()` taken while the port is pending still reads `verifying`. |
| same | Status says not signed in, so the operation ends `failed` with `verification_failed` and the port is never called (failure keeps the error). |
| same | The port rejects or never answers within the fake timer, and the operation still ends `authenticated`. |
| same | The deadline timer fires while the port is pending, and the operation still ends `authenticated`, not `timed_out`. |
| `src/lib/accounts/codexRuntime.test.ts` | `completed(loginId, true)` leads to the port being awaited before the record reads `completed`; `completed(loginId, false)` settles `failed` with no port call; a cancel during the read leaves the attempt `cancelled`. |
| `src/lib/accounts/liveLimits.test.ts` (or the existing limits-refresh route test) | A seeded registry holds a pre-login `authenticated: false`, `source: "unavailable"` observation and a cached failure with a future `retryAt`. A forced `login-complete` read with a fake probe records `authenticated: true`, `source: "live"`, and a following non-forced `QuotaController.tick` with the same fake keeps it authenticated (no `carryForward` back to the error). This covers "a later success clears an old error" at the projection: `accountProjection` reads `authenticated`. |
| `src/hooks/useEngineAccounts.test.ts` | A fetcher sequence of `verifying` + `error`, then `authenticated` + live limits, bumps `limitsVersion` once and leaves `authHealth: "authenticated"` and the limits on the row. A sequence ending in `failed` keeps `login.result.status === "failure"` and does not bump. |
| `src/components/AccountsPanel.dom.test.tsx` | Main with an old failed attempt, then a retry whose read ends `authenticated` with a live observation: the row shows the authenticated badge and limits, and neither the failure alert nor «Повторити» remains. |

## Rendered evidence

Extend the existing `BOARD_CAPTURE_CASE=claude-login` case in `scripts/capture-board-geometry.ts`
(`claudeLoginMain`, `:3533`). Do not add a new driver. That case already stubs `/api/accounts` at
the network layer on «Account B», walks 1440 × 900 and 390 × 844, en and uk, light and dark, and
writes `claude-login.json`. Add a third phase after `expired`, where a retry runs
`verifying → authenticated`:

- **before:** `phase: "verifying"` and `authHealth: "error"`, no limits. Expect the spinner line
  and the «Помилка входу» / "Auth error" badge.
- **after:** the next stubbed poll answers `phase: "authenticated"`, `authHealth: "authenticated"`
  and a limits block with a session and a weekly window plus a plan. With no click, expect within
  one 2.5 s poll:
  - the authenticated badge;
  - both window rows, and no «поки немає даних» / "no data yet";
  - no «Повторити» / "Retry" button in the row;
  - the footer summary showing the weekly percentage.

States to capture and measure, at each of 1440 × 900 and 390 × 844, in en and uk, light and dark
(16 frames per state):

| State | Must hold |
|---|---|
| verifying (before) | spinner line inside the panel; badge reads the error copy; Cancel present; on the phone every target ≥ 44 px |
| authenticated (after) | badge reads `accounts.auth.authenticated`; limit rows present; no `limits.noDataYet` in the card; no `accounts.retry` in the row; footer summary carries the weekly number |
| failed (control) | the existing `expired` frame: the error line and Retry stay, so the failure path is unchanged |

Record in the JSON, per tag:

- the number of `/api/accounts` reads between the authenticated answer and the assertion (≥ 1,
  no click);
- the badge text, the limit row count, and whether `accounts.retry` is present;
- the card and footer boxes. No row may overflow the panel, and no control may be clipped or
  zero-width.

On the phone the sheet is `[data-mobile2-accounts-engine="claude"]`, and the card is
`MobileAccountCard` (`AccountsPanel.tsx:1281`).

A stubbed `/api/accounts` cannot prove the server's ordering, so the unit tests above own that.
The frames prove the client renders the transition with no manual step. Frames stay out of the
tree. Commit `evidence/**/claude-login.json`. The frames go in an intermediate commit only, as
the project rules for PR frames say.

## What must not change

- **The failure path.** A `failed`, `timed_out`, `interrupted` or `canceled` login keeps its
  sanitized error line and Retry (`ClaudeLoginRow`, `AccountsPanel.tsx:652-666`), and no read
  runs for it.
- **The login phases and their copy.** No new phase, no new string, no new control. «Оновити»
  stays as the manual re-read.
- **The poll cadence.** It stays 2 500 ms for a live Claude login, 10 000 ms for a Codex device
  login or a draining migration, and none otherwise. This change adds no background poll.
- **History stays hidden.** A finished login from before a reload stays hidden (`currentLogins`,
  `useEngineAccounts.ts:665-675`, #2167).
- **Write fences.** The controller's tick ordering and commit fences stay as they are
  (`quotaController.ts:280-375`), including the
  `previous.authCheckedAt > now` skip that keeps an older in-flight tick from overwriting the
  login-time read.
- **Provider accounts.** Their auth (`route.ts:151-161`, messages health) keeps its own path.
  They have no OAuth login, so the port is never reached for them.
- **Recovery after restart.** `recoverAfterRestart` (`claudeLogin.ts:340`, `reconcilePersisted` `:695-735`) stays
  bounded. It does not run the read, because the Viewer's activation awaits it.
- **Server and identity rules.** No route changes shape, and no identity reaches the client.
  `GET /api/accounts` stays a pure projection.

## Options considered

- **A. Read at login completion on the server (recommended, specified above).** This fixes the
  data where it goes stale, for every reader and every tab, including a tab that was closed
  mid-login. It also clears the cached failure, so the controller cannot write the error back.
  It costs one port on two runtimes, and the "done" moment arrives one provider read later
  (about 1 s, at most 15 s).
- **B. Client trigger only.** The store calls `refreshLimits(accountId)` when it sees its watched
  login succeed. That is one module, and it reuses the button's path exactly. It fixes nothing
  when no tab watches the login, and the error stays on the server, and on the capacity gate for
  spawns, until the cache backoff ends (60 s, up to 15 min). It also shows the «Оновити» spinner
  and, on failure, a "could not re-read limits" notice the operator never asked for. Not chosen.
- **C. Hide observations older than the credential file.** This would compare `authCheckedAt`
  with the `.credentials.json` mtime, as provider accounts already do (`route.ts:155-157`).
  Rejected: the CLI rewrites that file on every token refresh, so healthy accounts would
  periodically drop to «Вхід не перевірено».

## Deferred — not currently justified

- **The `carryForward` mislabel.** `carryForward` writes `authenticated: false` for an
  authenticated account whose limits are unreadable and which has no previous limits
  (`quotaController.ts:266-277`). That reads as «Помилка входу» when the true state is "signed
  in, limits unknown". With A, the forced read clears the cached pre-login failure, so this no
  longer fires after a login. It still fires if the provider refuses the usage read (429,
  timeout) right after login, or at any other time limits are unreadable on a limits-less
  account. Changing it moves `headlessSelection.ts:32` and the auto-balance inputs, so it needs
  its own task and review, not this fix.
- **Running the read after a restart recovers an authenticated login.** That path runs at Viewer
  activation with no operator watching, and the next controller tick plus the client's first
  read already settle it.
- **Copilot.** It has no in-sheet sign-in.
- **A general "re-read when the sheet opens".** Not needed once completion writes the truth. It
  would add a request per open for every operator.
