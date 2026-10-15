# External native Claude caller association (#2827)

## Governing decision, 2026-10-15

An external Claude session gets identity only through an explicit operator
association. Its caller-writable PID record supplies evidence for the operator
and never grants identity on its own. This decision supersedes the earlier
record-only admission design, including its accepted forgery and asynchronous
session-switch risks. Hosted ancestry and recognized launch capabilities keep
precedence; a malformed, unknown or conflicting credential remains refused.

## Operator flow

A valid external stdio caller on Linux requests association on its first
recoverable mutation. Delegatus records one question round for the exact
process and transcript evidence in the existing Waiting for you / Decisions
surface. There is no additional panel, page or pill. The form names Claude,
the working directory, process start time, transcript and PID. Both questions
default to refusal. The operator explicitly approves the process and verifies
the displayed session. Skipped questions, custom answers, recommendations and
answers with reservations never grant identity.

Association decisions require independent owner authentication. HTTP decisions
require a current, unrevoked Telegram sign-in for an active owner member whose
linked Telegram identity matches the configured paired owner. A self-claimed
owner, a local passkey, browser-shaped headers and the Viewer's perimeter access
key supply no such authorization. A missing or unavailable pairing refuses
approval. The existing paired-owner relay can also save an explicit decision
through its in-process authorization guard. Both paths record the verified
authorization source locally on the decision; caller-supplied fields are ignored.
The guard runs inside the round mutation for approval, refusal and retry, so
another decision route cannot bypass it. Other decision forms keep their
existing authorization rules.

The binding digest is versioned. Rounds saved before this authorization boundary
remain history and grant no access; the caller requests a fresh round. The
approval predicate also requires the server-recorded authorization source and
matching actor kind. An identical authenticated answer can replace a decision
that lacked that proof.

The caller receives `caller_unidentified` with `approval-waiting` and the
location of the pending approval. No mutation receipt is claimed and no work
is dispatched. After approval, it repeats the same request with the original
`clientRequestId`. The saved operator decision is the durable Delegatus binding.
Its scope includes the process-start identity, PID domain, transcript, session,
record revision, hook generation marker. A sibling process needs a
separate approval. No caller argument can supply a decision or override this
scope. The approved live association stays as a saved record in the existing Decisions
column, with Revoke access. It contributes no pending question or badge.
Revocation saves explicit refusal through the operator decision route; the next
call refuses access, including recovery.

Approval checks that the shown process and record still exist and that the
hook generation still agrees. A stale form receives 409 and grants nothing.
The admission resolver repeats the current registry generation and host guards
when the approved caller uses it. Old approvals are retained as decision
history; they confer no authority on an ended process or another generation.

## Session proof and lifetime

The supported Claude hooks are configured in the [MCP guide](../guide/mcp.md).
The packaged `delegatus-mcp --native-caller-hook` command accepts SessionStart,
SessionEnd and synchronous PreToolUse events. Its nearest Claude ancestor and
process-start identity come from the kernel; stdin cannot choose a PID. The
hook input supplies Claude's current session and transcript independently of
the asynchronously updated PID record. The [Claude hooks contract](https://code.claude.com/docs/en/hooks)
defines those fields and PreToolUse input replacement.

A lifecycle start creates a fresh Delegatus generation marker; a lifecycle end
closes it. PreToolUse also replaces the marker when the session or transcript
changes, so a session switch is caught even before the PID record updates.
Each tool call gets a random proof bound to that generation, parent process,
tool and exact logical input. It expires after five minutes and is consumed
once by the stdio request. Retries receive fresh proof with the same original
key. At most 32 pending proofs remain per process, and lifecycle changes retire
the old set. Missing hooks and stale, expired, replayed or mismatched proof
receive `session-proof-unavailable` and an actionable configuration route.
The hook changes no Claude permission decision and grants no association.
While input is pending, it watches the process-start identities of both its
immediate parent and its Claude ancestor. Their exit stops the hook and its
packaged wrapper.

The proof travels in an optional `nativeCallerProof` transport field, removed
before logical argument normalization, receipt digests and downstream dispatch.
One RPC's async context shares its consumed proof across all admission/use
checks; another RPC needs fresh proof. Every check corroborates its generation
against Delegatus's current record, so a lifecycle change invalidates even an
in-flight proof. Operator approval still binds exactly that process and
transcript generation, and the caller-writable PID record alone grants nothing.
HTTP callers and platforms other than Linux retain their existing refusal.

The bounded record reader pins a regular, same-user file without following
symlinks. Its revision includes the inode, modification and change times and a
digest of the bytes. It rejects a file changing while read. Admission copies
and rereads the session record after the registry read and after checking the
operator decision, then checks process identity and ancestry again. Changing
the session or record revision invalidates that proof even if the PID survives.
A rewritten old record needs fresh approval; restoring its bytes does not
restore the original revision. A new hook generation with a still-old CLI
record is refused, covering the asynchronous update window.

The proof travels through authority and the recoverable request binding.
The MCP service revalidates it after asynchronous binding, inside the receipt store lock before a claim,
before dispatch, at the HTTP mutation boundary and before returning receipt
information. A switch before admission claims and dispatches nothing. A switch
after a claim fences it as undispatched when possible. Work already dispatched
keeps its receipt and remains recoverable by an authenticated continuation;
its result is withheld from a session that changed during the operation.

Receipt ownership remains conversation-based. A newly approved continuation
of the same conversation can recover the original key after process exit;
it cannot inherit the old process's approval. A sibling claiming an ended
session UUID while keeping its own valid PID/start/domain record is refused
without reading the old receipt or mutating as its owner. Its forged PID record
also cannot block an authenticated continuation: duplicate ownership requires
agreement with the other process’s hook-observed session. Native callers
continue to register no launch-completion notice recipient.

## Verification

Explicit test paths:

- `src/lib/attention/nativeCaller.test.ts`: process reuse/exit, ancestry, boot
  and domain boundaries, current generation, host reservation, duplicate
  ownership, transcript containment, missing approval, changed hook generation/revision,
  and a real `readNativeSessionRecord` rewrite during `snapshot`.
- `src/lib/attention/nativeCallProof.test.ts`: one-use proof, exact input/tool/parent
  scope, session start/end and return-to-generation refusal, and expiry boundaries.
- `src/lib/attention/nativeAssociation.test.ts`: the existing attention surface,
  durable authenticated approval, revocation, header-free self-approval refusal,
  forged browser headers, unproven owner bootstrap, mismatched Telegram identity,
  missing pairing, expired/revoked sessions, legacy decisions, skipped and custom
  answers, and stale approval refusal.
- `src/lib/attention/callerAuthority.test.ts`: hosted and capability precedence,
  conflict refusal, and propagation of the approved generation proof.
- `src/lib/mcp/server.test.ts`: generation switches across asynchronous binding
  and receipt lookup, with zero new claims or dispatch and no receipt disclosure.
- `src/lib/mcp/stdio.integration.test.ts`: packaged stdio calls through real
  process records, the operator decision route, production send/spawn handlers,
  lost-response and approved-continuation recovery, the same-user forged UUID
  attack after the owner exits, forged hook input followed by header-free
  self-approval, the asynchronous record-update window, proof replay,
  revocation, duplicate sessions, stale records and owner death through both
  the bundle and packaged wrapper.
- `src/components/kanban/kanbanBoard.browser.test.tsx`: the existing decision
  form on desktop and phone in both languages and themes, with production form
  text, full session evidence and explicit approval answers.

Run each selected test path through the mandatory gate runner with isolated
HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR under the OS temporary root,
and LLV_VIEWER_CONTROL_URL on a closed loopback port. Browser tests additionally
need LLV_KANBAN_BROWSER_TEST=1 and CHROME_BIN. Checks include the packaged MCP
build, TypeScript, changed-file lint and the fingerprinted publication privacy
gate. Render readings live in `evidence/native-association/decisions.json`.

## Scope

This changes caller identity and its approval through the existing decision
surface. Native input batching (#2742), history-root safety, external Codex,
other-platform admission and capability-header Viewer routes remain outside
this change. The neighboring lane's spawn recovery and spawn policy are
untouched.

The earlier implementation's verification on 2026-10-15 established the #2827
refusal on base f746d7f2 and the hosted/capability precedence checks. Review
then reproduced same-user receipt takeover and a session switch during
snapshot. The operator decision above governs this revision and both attacks
are now permanent regression cases.

Review on 2026-10-15 also reproduced header-free self-approval through Decisions
and receipt takeover using forged PID and hook metadata. The authenticated-owner
boundary and versioned association binding above supersede that revision's
anonymous-loopback operator classification for native associations.
