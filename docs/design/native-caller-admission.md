# Native caller admission: identifying a Claude session Delegatus did not launch

## Originating requirement

The operator, 2026-10-14, in Ukrainian, as relayed in the pinned task for this
lane (verbatim):

> «після деплою розбирай іш'ю нові … спочатку агент має переконатися що все актуальне»

("After the deploy, work through the new issues … first the agent must make
sure everything is current.")

The issue this design answers is #2827, *MCP mutations cannot identify
externally launched native Claude sessions*. A verifier confirmed it live on
main `f746d7f2`. Before writing this, remote main was re-read at `08315898`
(one later commit, #2872); that commit touches none of the files cited below,
so every line anchor here holds on both.

Pinned outcome: an explicit, supported association or admission route for a
Claude session started outside Delegatus, with an actionable message telling it
how to get admitted. Fail-closed stays the rule: process-start identity,
generation ownership and capability agreement are verified; PID reuse, stale
metadata, unrelated sessions and conflicting capability evidence remain refused.
After association, attributed mutations and original-key recovery work. Out of
scope: #2742 (native input batching) and history-root safety (lane 8b779f43).

Acceptance from #2827:

- reproduce a native external caller that is visible in a completed scan but
  has no registry host;
- a supported association allows a mutation and durable same-key recovery under
  the actual calling conversation;
- PID reuse, stale session metadata, disagreement and unrelated sessions remain
  unidentified;
- existing managed callers retain attribution and same-key receipt recovery;
- no running external session is stopped, taken over or altered to make a test
  pass.

## Decision in one paragraph

Add a third evidence chain, **verified native session evidence**, consulted only
when the two existing chains (registered host pid, injected capability) name
nobody and no capability was presented at all. The MCP server walks its own
kernel ancestry to the nearest Claude process, reads the session record that
Claude Code itself writes for that process (`<claude home>/sessions/<pid>.json`),
requires its pid, kernel start token, pid domain and start time to match the
live kernel, and requires the session id it names to be exactly one registry
generation that is current and not run by a Delegatus host. Nothing is stored,
so there is nothing to expire, revoke or replay: every call proves it again.
The same change makes the existing pid chain compare the recorded start
identity, which closes the one PID-reuse path an external process could use to
be attributed to someone else. Every `caller_unidentified` refusal names the
check that failed and the two ways to be admitted.

## Against the originating requirement

The operator asked for new issues to be worked through after the deploy, with
the agent first making sure everything is current. For this issue that means:
#2827 was confirmed live on `f746d7f2` by the verifier; remote main was re-read
at `08315898` and none of the cited files moved; the evidence about Claude Code
below was measured on this machine on the day of writing, on the installed CLI.
The design then builds the smallest route that meets #2827's acceptance, and
everything beyond it sits under "Deferred".

## How a caller is identified today

| step | where | what it decides |
| --- | --- | --- |
| Ancestry | `src/lib/attention/callerAuthority.ts:131` `processAncestry`, fed from `procBackend.readPpid` in `src/lib/mcp/bindings.ts:1184` | the MCP server's own pid, then each parent, at most 24 hops |
| Hosted pids | `src/lib/mcp/bindings.ts:1133-1153` `hostedConversationsFromSnapshot` | every registry conversation, joined to registry entries by transcript path; pids are `entry.host.agent.pid` and `entry.structuredHost.process.pid`, matched on the **pid alone**; the recorded start identity is ignored |
| Capability | `src/lib/mcp/bindings.ts:1156-1177` | the launch-injected `LLV_SPAWN_CAPABILITY` (or the HTTP caller's header) hashed and looked up in spawn receipts |
| Decision | `src/lib/attention/callerAuthority.ts:68-112` | nearest ancestor pid in the hosted set wins; pid and capability that disagree are `unidentified`; either alone identifies; otherwise `unidentified` |
| Receipt caller | `src/lib/mcp/bindings.ts:7287-7320` `recoveryCaller` | `{kind, conversationId, project, predecessors}` from that decision; any fault is `unidentified` |
| Refusal | `src/lib/mcp/server.ts:2709-2711` | a recoverable mutation (`spawn_agent`, `send_message`, `send_message_to_orchestrator`, `create_pipeline`) with an unidentified caller is refused before any claim, with the fixed text at `server.ts:2456` |
| Recovery | `src/lib/mcp/server.ts:2427-2433` `sameCaller` | the same `kind`, `project` and `conversationId` (or a server-derived predecessor) may read an existing claim |

Two neighbouring facts shape the design:

- **The Viewer routes judge identity by the capability header alone.**
  `requireOperatorAuthority` (`src/lib/agent/operatorAuthority.ts:176`) treats a
  request that presents no capability as the operator. An external session's
  MCP server forwards no capability (`callerCapabilityHeaders`,
  `bindings.ts:4105`), so the designation and prototype routes already see it
  as the operator lane. Admission in the MCP server changes nothing there and
  mints no capability.
- **A scanned external transcript already has a registry identity.** Inventory
  creates the conversation with one generation whose id is the session UUID
  from the file name (`src/lib/agent/registry.ts:2098-2105`, `:8234`), `host:
  null`, and role `worker` unless `LLV_ROOT_CONVERSATION_ID` names it
  (`src/lib/accounts/migration/coordinator.ts:421`). That conversation has no
  registry entry, so `hostedConversationsFromSnapshot` gives it `pids: []` and
  it can never win the ancestry walk. This is the gap the verifier reproduced.

## Evidence that exists for an external Claude session

Measured on this machine on 2026-10-15 with Claude Code 2.1.296, read-only.

**Claude Code's own session record.** Claude Code registers each process by writing
`<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` (directory mode 0700, file mode
0664). Fields: `pid`, `sessionId`, `cwd`, `startedAt` (ms), `procStart`,
`pidDomain`, `kind`, `entrypoint`, `version`, `status`, `updatedAt`, plus name
and peer-messaging fields.

- `procStart` equals field 22 of `/proc/<pid>/stat` (start time in clock ticks
  since boot) for all 7 live records in a Delegatus account home. Delegatus's
  own start token is `<pid>:<field 22>` (`src/lib/proc/linux.ts:59-63`), so the
  comparison is exact string equality.
- `pidDomain` is `linux:<machine-id>:<readlink /proc/self/ns/pid>`, read from
  the CLI bundle; computing it from our side matched all 7 live records. It
  names the machine and pid namespace and carries nothing about the boot.
- `startedAt` is written about one second after exec (0.78 s measured against
  `btime + procStart / CLK_TCK`).
- `CLAUDE_CONFIG_DIR` in each process's initial environment
  (`/proc/<pid>/environ`) named the home holding its record, 7 of 7.
- The CLI rewrites `sessionId` and `updatedAt` in the record when its session id
  changes (its session-id listener calls the pid-file updater), and `cwd` when
  the working directory changes. The record follows `/clear` and `/resume`
  inside one process, asynchronously.
- Records outlive unclean exits. The default `$HOME/.claude/sessions` held 8
  records, all naming pids that no longer run. Claude's own reader treats a
  record older than its process as torn.

**The operator's `viewer` MCP server is stdio.** The global Claude config
starts it as `bun <path>`, so an external session's MCP server is a direct
child of the Claude process and its ancestry reaches that process in one hop.

**The registry's pid chain is exposed to PID reuse.** 48 registry entries carry
a structured-host pid; 24 of those pids no longer run. All 48 carry a start
identity and a boot epoch, but `hostedConversationsFromSnapshot` matches on the
pid alone. An external process that inherits one of those 24 pids is attributed
to the stale row's conversation by the existing chain, before any new evidence
would be read.

**What is not evidence.** The scanner's `FileEntry.pid` for an interactive
transcript comes from a writable fd, an argv session id, or a cwd fallback that
picks the only tty-attached Claude in the project directory
(`src/lib/scanner/transcripts.ts:151-229`), memoized for 12 s
(`src/lib/scanner/process.ts:11`). The cwd fallback is every sibling
transcript's neighbour, and #2827 forbids inferring identity from cwd. The
session record's own `cwd` field is not read either.

## Options

| | A. Verified native session evidence | B. Operator-approved association record | C. Admission by continuing in Delegatus |
| --- | --- | --- | --- |
| Who initiates | nobody; the MCP server resolves it on each identity-bearing call | the refused session receives an admission code; the operator approves it on the board or from the CLI | the operator, told by the refusal to continue the conversation from Delegatus |
| What binds session to process and generation | kernel ancestry to the nearest Claude pid; that pid's own CLI record matching the live kernel start token, pid domain and boot; the record's session id resolving to exactly one current, unhosted registry generation | A's evidence at approval time, plus a stored record `{conversationId, sessionId, pid, startIdentity, bootEpoch}` the operator approved | the existing chains: a Delegatus host pid with a recorded identity and an injected capability |
| Expiry | nothing is stored; identity ends when the process exits, its start token changes, the boot changes, the CLI switches session, or Delegatus takes the conversation over | the stored process identity dies; a restarted terminal needs a new approval, or the record is kept per conversation and becomes an allow list over A | the host's lifecycle and capability rotation, as today |
| Revocation | nothing to revoke; stop the external process or continue the conversation in Delegatus | the operator deletes the record | as today |
| New surface | one pure resolver, one adapter module, refusal text | A plus a durable store, a board item or CLI verb, an operator step per terminal session | refusal text only |
| Meets #2827 acceptance | yes | yes | no: the running session is never identified, and the acceptance asks for mutations under the actual calling conversation |

A fourth shape was considered and dropped: a caller-initiated nonce that the
session echoes through a tool call, verified in its own transcript. It depends
on the CLI writing the tool-use record before it dispatches the MCP call, which
nothing documents, and adds a tool; A is already anchored in kernel facts.

**Chosen: A**, with C's continuation route written into every refusal as the
fallback. B is rejected as OVER-BUILT for this threat: its approval looks at
the same evidence A verifies, so it adds an operator step to every terminal
session and a store to maintain while closing no attack A leaves open. The
operator has asked for work that runs without manual steps.

"Explicit" in the pinned outcome is read as a named, documented evidence chain
with its own refusal reasons, which #2827 itself proposes ("If verified native
process/session evidence is accepted, bind nearest ancestry to its native
generation with process-start identity"). Nothing the caller says, and no cwd,
participates.

## Design

### Precedence

1. **Registered host pid**, nearest ancestor first, as today, with one change:
   a pid matches only when the recorded identity is the live process. The row's
   `startIdentity` must be non-null and equal the kernel's current start token
   for that pid, and its `bootEpoch`, when recorded, must equal the current
   boot epoch (`sameRecordedProcessIdentity`,
   `src/lib/processIdentity.ts`). A row without a start identity never matches.
   On this machine every one of the 48 rows carries both fields, so no live
   managed caller loses its match.
2. **Capability**, as today. Pid and capability that disagree stay
   `unidentified`.
3. **Native session evidence**, consulted only when step 1 found no live match
   **and** no capability value was presented at all: no `LLV_SPAWN_CAPABILITY`
   in the MCP server's environment and no HTTP caller. A capability that is
   present but malformed or resolves to nothing stays `unidentified`, exactly as
   today; native evidence never fills in for it.

A Claude process started inside a managed agent's tree is still attributed to
that agent by step 1 or 2, so existing attribution is unchanged.

### The native checks

`resolveNativeCaller(sources)` in a new pure module
`src/lib/attention/nativeCaller.ts`, beside `callerAuthority.ts` and pure over
supplied sources in the same way. The production sources live in
`src/lib/attention/nativeCallerSources.ts` (Linux `/proc` readers, the Claude
homes from `listClaudeAccounts()`, the bounded record reader). The checks run
in this order; the first failure is the answer.

| # | check | refusal reason |
| --- | --- | --- |
| N0 | Linux process backend; no HTTP caller; no capability presented (a presented capability that resolves to nothing answers here) | `platform-unverified`, `no-claude-ancestor`, `capability-unresolved` |
| N1 | the nearest ancestor (skipping the server itself) whose argv is the Claude engine (`argvEngine`, `src/lib/scanner/process.ts:123`) and not a helper (`isHelperArgv`, `:189`). A farther Claude ancestor is never consulted | `no-claude-ancestor` |
| N2 | that process carries no structured-host stamp of any value (`readStructuredHostStamp`, `:151`); a stamped Claude belongs to some Delegatus installation, and ours would have matched in step 1 | `foreign-host` |
| N3 | its Claude home is `CLAUDE_CONFIG_DIR` from its initial environment, else `$HOME/.claude`; the realpath must equal the home of an account in `listClaudeAccounts()` | `unknown-claude-home` |
| N4 | `<home>/sessions/<pid>.json` is a regular file (no symlink), owned by our uid, at most 64 KB, a JSON object with `pid` equal to this pid, a UUID `sessionId`, `kind: "interactive"`, a digit-string `procStart`, a string `pidDomain`, a number `startedAt` | `session-record-missing`, `session-record-invalid`, `session-kind` |
| N5 | `<pid>:<procStart>` equals the kernel start token, read before and after the record, with the pid still in our ancestry after the read | `process-identity-mismatch` |
| N6 | `pidDomain` equals `linux:<machine-id>:<readlink /proc/<pid>/ns/pid>` | `domain-mismatch` |
| N7 | `startedAt` is at or after the current boot time (`btime` from `/proc/stat`) and no earlier than five seconds before the process start the kernel reports. This check is what ties the record to the current boot | `record-predates-process` |
| N8 | no other record in any known home's `sessions/` names the same `sessionId` for a different live process whose start token matches its record | `session-held-twice` |
| N9 | exactly one registry conversation of engine `claude` has a generation whose id is the `sessionId` | none: `session-not-scanned` (retryable); several: `generation-ambiguous` |
| N10 | that generation is the conversation's newest, `archivedAt` is null, `supersededBy` is null, and no migration is in flight | `generation-not-current` |
| N11 | the generation's transcript realpath lies under the realpath of the matched account's `projectsDir` and is named `<sessionId>.jsonl` | `transcript-outside-home` |
| N12 | every registry entry for that transcript path names a host whose recorded identity is proven dead (`processIdentityStatus === "dead"`); `alive` or `unverified` refuse | `generation-hosted` |

The result names the conversation id. `callerAuthority` resolves its role from
the hosted list (every conversation is in it), so a conversation that
`LLV_ROOT_CONVERSATION_ID` names is the root and every other one is a worker,
the same rule every other chain uses.

Cost per call: one ancestry walk (already done), one environ read, one record of
at most 64 KB, one directory listing per known home for N8, and lookups in the
registry snapshot the call already reads. The home list may be cached for the
MCP process with a short TTL; accounts change rarely.

### What the authority carries

- `AttentionCallerSources` (`callerAuthority.ts:35`) gains
  `capabilityPresented?(): boolean` and `nativeCaller?(): NativeCallerVerdict`.
  `attentionCallerAuthority` calls `nativeCaller` only under the precedence
  above.
- The `root` and `worker` variants gain `evidence?: "native-session"`; the
  `unidentified` variant gains `admission?: NativeCallerRefusal`.
- `callerAttributionFrom` (`bindings.ts:1031`) carries `native: true` through.
  `mcpSpawnLauncher` (`bindings.ts:4060`) returns null for it, the rule the
  spawn-completion-notice design already applies to gateway launchers
  (`docs/design/spawn-completion-notice.md`, Deferred): a notice would be
  delivered into a terminal Delegatus does not run. Lineage and attribution of
  the launch itself are unaffected.
- `hostedConversationsFromSnapshot` takes an optional identity probe and keeps
  only pids whose recorded identity is live. Production passes the kernel probe;
  existing pure tests that pass none keep today's behaviour.
- `recoveryCaller` copies `admission` onto the unidentified
  `McpRequestCaller` as an in-memory field. An unidentified binding is refused
  before it is claimed (`server.ts:2709`), so this field is never persisted, and
  `validRequestBinding` (`server.ts:921`) and `sameCaller` need no change. The
  receipt shape on disk is unchanged.

### The refusal

The code stays `caller_unidentified` and the answer keeps exactly its current
keys, with no `details`, so it still discloses nothing about whether the key
exists (`src/lib/mcp/server.test.ts:2306-2315` pins this). The text keeps its
current first sentence and appends the reason and the route:

> the caller's identity could not be established, so this mutation is refused
> before anything is claimed or dispatched. *Reason sentence.* A Claude Code
> session started outside Delegatus is admitted automatically when this
> `viewer` MCP server runs over stdio as a child of the Claude process on
> Linux, and that process's own session record (`sessions/<pid>.json` in its
> Claude config directory) matches the live process and names a conversation
> Delegatus has scanned and is not running itself. Otherwise open the
> conversation in Delegatus and continue it there; Delegatus then runs it under
> a host of its own.

Reason sentences, one per refusal, for example: "This MCP server has no Claude
Code process among its parents (an HTTP transport or another client)"; "The
session record for the parent Claude process is stale: it was written for an
earlier process with the same pid. Restart Claude Code"; "Delegatus has not
scanned this session yet. Repeat the same call with the same clientRequestId
after the next inventory pass, about a minute"; "Delegatus is already running
this conversation under its own host. Send to it there, or stop one of the two"; "This process carries a Delegatus launch credential this installation does not recognise (another installation or a retired launch). Start the session from this Delegatus".

`retryable` is `true` only for `session-not-scanned` (the inventory pass runs
every 60 s, `src/lib/accounts/migration/controllerSignal.ts:5`); every other
reason keeps `false`.

### What changes for an admitted external session

| surface | before | after |
| --- | --- | --- |
| `spawn_agent`, `send_message`, `create_pipeline` | `caller_unidentified` | admitted; the receipt is bound to the external conversation and only that conversation can recover the key |
| `send_message_to_orchestrator` | `caller_unidentified` | passes the identity gate; the relay's own seat-only rule then applies, as for every worker |
| launch completion notices | none | none: a native caller is never recorded as launcher |
| `issue_report`, `update_task` refine, retirement observation | refused | allowed for the caller's own conversation |
| message origin of a send | unattributed agent | attributed to the external conversation |
| `agent_fleet` | an unidentified caller may name any project | limited to its own project, like every worker; the root sees all |
| `request_attention`, `suggest_replies`, `dismiss_attention`, needs-you reads, archive | refused | still refused for a worker; allowed for the configured root or a designated seat, as for any identified conversation |
| Viewer routes that read the capability header (designation, prototype reviews) | operator lane | unchanged; no capability is minted or forwarded |

A conversation the operator designated as a project seat while it runs in a
terminal becomes a working seat once its process is admitted. The seat route
already accepts scanned conversations (`src/lib/orchestrator/seatCommand.ts:331-351`);
designation stays the operator's act.

## Threat cases and their tests

Pure tests run without a process tree. The integration block runs a real
process tree in a sandbox: a `claude`-named launcher (a symlink to the Bun
binary, so `argvEngine` reads `claude` from argv) that starts the real stdio MCP
entry as its child with inherited stdio, a session record the test writes for
the launcher's real pid and start token, and a registry conversation
reconciled the way inventory does it. No real Claude session is read, stopped,
taken over or altered.

| threat | case | test (file, name) | expected |
| --- | --- | --- | --- |
| PID reuse | the record's `procStart` differs from the kernel's for that pid | `src/lib/attention/nativeCaller.test.ts` "a record written for an earlier process with the same pid is refused" | `process-identity-mismatch` |
| PID reuse | the record's `pid` field differs from its file name and the ancestor | `nativeCaller.test.ts` "a record copied under another pid is refused" | `session-record-invalid` |
| PID reuse | the start token changes between the two reads, or the pid leaves the ancestry | `nativeCaller.test.ts` "a parent that exits while its record is read is refused" | `process-identity-mismatch` |
| PID reuse | a stale registry row names the ancestor pid with another start identity | `src/lib/mcp/managerAuthority.test.ts` "a host row whose pid was reused names nobody" | no match in step 1; with a valid record, the native conversation; the stale row's conversation in no case |
| PID reuse | the same, end to end | `src/lib/mcp/stdio.integration.test.ts` native block "a reused host pid is not inherited" | the call is attributed to the native conversation |
| Stale metadata | `startedAt` before the current boot with matching pid and start token | `nativeCaller.test.ts` "a record from an earlier boot is refused" | `record-predates-process` |
| Stale metadata | `pidDomain` names another machine or pid namespace | `nativeCaller.test.ts` "a record from another pid domain is refused" | `domain-mismatch` |
| Stale metadata | the generation is not the newest, is archived, is superseded, or is migrating (table-driven, four rows) | `nativeCaller.test.ts` "a session that is no longer the conversation's current generation is refused" | `generation-not-current` |
| Stale metadata | a registry entry for the transcript names a live host; the same with an identity lacking a boot epoch; the same with a dead host | `nativeCaller.test.ts` "a generation Delegatus is running is refused until its host is proven dead" | `generation-hosted`, `generation-hosted`, admitted |
| Stale metadata | the session id is not in the registry, then inventory reconciles it | `nativeCaller.test.ts` "an unscanned session is refused as retryable and admitted once scanned" | `session-not-scanned` with `retryable: true`, then admitted |
| Stale metadata | end to end: record rewritten with `procStart + 1`, then with `startedAt` before boot | native block "stale records refuse every mutation and dispatch nothing" | `caller_unidentified`, text names the reason, zero effects, no receipt |
| Unrelated session | the nearest Claude ancestor has no record and a farther Claude ancestor has a valid one | `nativeCaller.test.ts` "only the nearest Claude process can name the caller" | `session-record-missing` |
| Unrelated session | no Claude ancestor (HTTP transport or another client) | `nativeCaller.test.ts` "a server with no Claude parent is refused" | `no-claude-ancestor` |
| Unrelated session | the home is not a known Claude home; the record is a symlink | `nativeCaller.test.ts` "a record outside the known Claude homes is refused" | `unknown-claude-home`, `session-record-invalid` |
| Unrelated session | two conversations own a generation with that session id | `nativeCaller.test.ts` "a session id owned twice is refused" | `generation-ambiguous` |
| Unrelated session | the generation's transcript resolves outside the matched home's `projectsDir` | `nativeCaller.test.ts` "a transcript in another home is refused" | `transcript-outside-home` |
| Unrelated session | a second live process holds a record for the same session id | `nativeCaller.test.ts` "a session held by two live processes is refused" | `session-held-twice` |
| Unrelated session | the ancestor carries a structured-host stamp | `nativeCaller.test.ts` "a Claude host stamped by any installation is refused" | `foreign-host` |
| Unrelated session | the scanner catalog assigns the ancestor pid to a transcript by cwd and no record exists; the record's `cwd` differs from the transcript's | `nativeCaller.test.ts` "cwd decides nothing" | refused without a record; with a record, the record's session decides and cwd is never read (the sources expose no cwd or catalog reader) |
| Unrelated session | caller-supplied `callerConversationId` / `callerProject` arguments | native block "arguments never name the caller" | ignored; same identity as without them |
| Conflicting capability | a capability resolving to X plus a valid record for Y | `src/lib/attention/callerAuthority.test.ts` "native evidence is never read when a capability names the caller" | worker X; the native source is not called |
| Conflicting capability | a capability that resolves to nothing, or a malformed one, plus a valid record | `callerAuthority.test.ts` "an unresolved capability is never replaced by native evidence" | `unidentified`; the native source is not called |
| Conflicting capability | a registered live host in the ancestry above the native Claude process | `callerAuthority.test.ts` "a managed ancestor keeps a nested Claude process's attribution" | the managed conversation; the native source is not called |
| Conflicting capability | end to end: the launcher's environment carries an unknown 43-character capability | native block "an unknown capability refuses native admission" | `caller_unidentified` naming `capability-unresolved`, zero effects |
| Replay | a key claimed by native caller Y is replayed by native caller Z (a second launcher, another session) | native block "another native session cannot read or reuse the key" | `recovery_not_permitted`, no ids disclosed, no second dispatch |
| Replay | Y's record is removed (process gone) and the key is replayed by the same server | native block "a vanished session cannot recover" | `caller_unidentified`, nothing disclosed |
| Replay | Y's session continues in a new process (new pid, new record, same session id) and recovers the key | native block "the same conversation recovers its key from a new process" | the original launch, `replayed: true`, one launch in total |
| Replay | a record copied byte for byte into another pid's file name | covered by "a record copied under another pid is refused" | `session-record-invalid` |

Positive acceptance, end to end in the native block:

- **Reproduction.** The fixture first asserts that the external conversation
  exists in the registry with no entry for its transcript. On the merge base
  the `spawn_agent` call below answers `caller_unidentified`, which is #2827
  reproduced; on the branch the same call is admitted. The case is therefore
  red on the merge base and green on the branch.
- **"an admitted external session launches, loses the response and recovers
  under the same key"**: `spawn_agent` with the response lost, `recoveryOnly`
  under the same key, then an MCP restart under a new launcher with a new
  record for the same session. One launch, one receipt, the receipt's bound
  caller is the external conversation, and no launcher is recorded on it.
- **"send_message from an admitted session is attributed to it"**: the
  delivered origin names the external conversation.

Managed callers keep their behaviour: the existing cases in
`src/lib/mcp/stdio.integration.test.ts` (send and spawn lost-response recovery,
spoofing and concurrency), `src/lib/mcp/managerAuthority.test.ts`,
`src/lib/mcp/managerLifecycleSeams.test.ts`,
`src/lib/attention/callerAuthority.test.ts` and the unidentified cases in
`src/lib/mcp/server.test.ts` must pass unchanged, apart from fixture rows in
`managerAuthority.test.ts` that gain real start identities where a test opts
into the identity probe.

Run each file by path, one at a time, through the slot wrapper, with isolated
`HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR` under `/tmp` and
`LLV_VIEWER_CONTROL_URL` pointing at a closed loopback port, for example
`bash scripts/gate-slot.sh bun test ./src/lib/attention/nativeCaller.test.ts`.
The baseline `src/lib/attention/callerAuthority.test.ts` passes 8 of 8 at
`f746d7f2` under that setup.

## Files the build touches

- new: `src/lib/attention/nativeCaller.ts`, `src/lib/attention/nativeCallerSources.ts`,
  `src/lib/attention/nativeCaller.test.ts`;
- `src/lib/attention/callerAuthority.ts` (sources, precedence, variants);
- `src/lib/mcp/bindings.ts`: `hostedConversationsFromSnapshot` (1133),
  `attentionCallerSources` (1179), `callerAttributionFrom` (1031),
  `mcpSpawnLauncher` (4060), `recoveryCaller` (7287);
- `src/lib/mcp/server.ts`: the refusal text and `retryable` at 2709-2711;
- tests listed above.

Fence: lane #2890/#2894 changes spawn recovery near `bindings.ts:7647`
(`recoverSpawn`) and `src/lib/agent/spawnPolicy.ts`. This design edits neither;
`recoverSpawn` picks up the launcher rule through `mcpSpawnLauncher`. If that
lane lands first, merge main before review.

## Residual risks, accepted

- **A forged record.** The record is mode 0664 in a 0700 directory, so any
  process of the same user can write one. A forged record for a session whose
  real process is not running admits the forger as that conversation; N8
  refuses it while the real process runs. Reading another process's
  `LLV_SPAWN_CAPABILITY` from `/proc/<pid>/environ` is the same level of access,
  and the existing chain accepts that. This design targets mis-attribution
  (reuse, staleness, nesting, wrong session), which it closes.
- **The session-switch window.** After `/clear` or `/resume` inside one process
  the CLI updates its record asynchronously; a call in that window resolves to
  the conversation the same process ran a moment earlier.
- **Only Linux** is verified. On other platforms every native verdict is
  `platform-unverified`.

## Deferred — not currently justified

- **Operator-approved association records (option B).** Build it only if
  admission by verified evidence admits a caller the operator did not want.
- **HTTP-transport external callers.** Resolving a loopback peer socket to its
  pid would give HTTP callers an ancestry; the operator's configuration is
  stdio.
- **macOS and Windows start-token verification.** The CLI writes a different
  token there (`procStartFt` on Windows) and its pid domain degenerates.
- **External Codex sessions.** A Codex process keeps its rollout open for
  writing, a kernel-anchored binding of its own; #2827 names Claude.
- **On-demand admission of an unscanned session** through a Viewer route. The
  MCP server must not write the registry; the retryable refusal covers the
  first minute.
- **Capability-header Viewer routes** (prototype reviews and the rest) for
  native callers.
- **Recording the evidence kind** in receipt bindings or lifecycle events, and
  a read that shows a caller how it is identified.
- **A kill switch** for the native chain; a revert is a deploy.
- **Launch completion notices to native callers.**
- **Session kinds other than `interactive`** (`bg`, daemon workers), where one
  process may host several sessions.

## Notes for the build lane

- #2827 reports `create_orchestrator` refused with `caller_unidentified`. At
  `f746d7f2` that tool is outside the recoverable set (`bindings.ts:7702-7743`),
  and the seat route treats a capability-less call as the operator
  (`src/app/api/orchestrator/seat/route.ts:196`). The likely path is
  `send_message_to_orchestrator` creating a missing seat. The native block
  should call `create_orchestrator` from a native caller before and after the
  change and act only on what reproduces.
- Prove each new integration case red on the merge base before calling it
  fixed.


## Implementation verification, 2026-10-15

The implementation uses the native chain only after hosted ancestry and launch
capability resolution. A presented credential that does not resolve refuses the
call, including when ancestry would otherwise match. Native worker, manager and
deputy attribution retain the native marker and never register a completion
notice launcher. Receipt bindings keep their existing durable shape.

The packaged stdio fixture creates a sandbox Claude-shaped parent, writes that
parent's real kernel start token and PID domain, and reconciles its transcript
through `AgentRegistry.reconcileConversations`. It asserts that the native
conversation has no registry host entry before calling the packaged server.
The controlled Viewer executes the production send and spawn handlers.

On base `f746d7f2`, the test named `REGRESSION #2827: a scanned external session
with no host can mutate and recover` fails at its first mutation with
`caller_unidentified`. Base checks produce seven expected failures: admission, lost-response recovery,
send attribution, cross-session recovery, duplicate live session ownership,
stale-record diagnostics and unresolved credential diagnostics. The eighth
case, `create_orchestrator`, passes on base;
its reported identity refusal was not reproduced on that tool.

Threat coverage in the implementation:

| Threat | Explicit test paths and cases |
| --- | --- |
| PID reuse and process exit | `nativeCaller.test.ts`: earlier process, changed/exited process during record read, changed ancestry and final identity recheck; `managerAuthority.test.ts`: hosted PID reuse, missing start token and boot mismatch |
| Stale metadata | `nativeCaller.test.ts`: boot/start boundary, foreign PID domain, old/archived/superseded/migrating generation, hosted or unverified generation, unscanned retry; `stdio.integration.test.ts`: stale records dispatch nothing |
| Unrelated session | `nativeCaller.test.ts`: nearest parent, known home, bounded regular record, transcript containment, duplicate generation/session ownership, foreign host stamp and absence of cwd evidence; stdio checks caller-argument spoofing and duplicate live records through the production reader |
| Conflicting capability | `callerAuthority.test.ts`: known capability and managed ancestry precedence, unresolved credential, conflicting chains; stdio checks unknown, malformed and empty credentials |
| Replay | `stdio.integration.test.ts`: other native session refused without disclosure, vanished record refused, original-key recovery after lost response and a new native parent process; durable binding and single-effect counts asserted |

All fixtures use isolated state, homes and temporary directories. Base evidence
comes from an archive of the base commit; the pipeline stays on its assigned
branch throughout.
