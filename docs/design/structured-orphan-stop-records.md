# Structured orphan stop records

An orphan stop appends its decision to the existing
`host-termination-journal.ndjson` beside the registry. The `captured` event
keeps its existing `at`, `source`, `key`, `root`, `pids` and `added` fields.
Its `decision` object describes the row read inside the capture transaction,
before any signal. Capture withdrawal and settlement retain their existing
events. This diagnostic changes no stop authorization or escalation rule.

The decision contains:

| Fields | Meaning |
| --- | --- |
| `caller`, `claimRefusal` | Fixed caller enum and the existing claim refusal enum, or null when unavailable. |
| `reason` | `orphan-writer-not-blocking`: the existing orphan writer guard allowed tree capture. |
| `ownerPid`, `ownerStartIdentity`, `ownerBootEpoch`, `ownerState` | Parsed claim identity and its current kernel classification: alive, dead or unverified; absent and invalid distinguish missing and malformed claims. |
| `claimEpoch`, `writerClaimEpoch`, `status` | Bounded nonnegative safe integer epochs and the registry host status enum. |
| `activeTurnRef`, `turnOpen` | SHA-256 reference to the open turn and whether a nonempty turn reference was present. |
| `ownershipState` | `read` or `unreadable`; a failed related-row observation leaves ownership evidence unavailable and does not refuse the existing stop. |
| `conversations`, `conversationsTruncated` | Up to four related conversations, their hashed IDs, whether the entry is their current generation, their turn state, and memberships. |
| `memberships`, `membershipsTruncated` | Up to four memberships per conversation: kind, hashed container/stage/parent IDs, stage order and round. |
| `runtimeHostGeneration` | Observed singleton fence owner PID, start identity and acquisition ID; `state` is read, missing, invalid or unreadable. |

The runtime generation is identified by its singleton fence acquisition.
Every acquisition gets a fresh ID, including a restart of the same revision.
The configured fence is read directly without acquiring it. The default is
the fence beside the runtime socket, resolved relative to the registry's
directory. A staged release record can name a future generation and is never
used for this observation. Fence metadata is diagnostic; a read does not
prove the owner still holds the OS lock. Missing evidence is recorded as such.

The callers in `src/lib/runtime/registry.ts` are Claude adoption, Codex
adoption, startup demotion and terminal recovery. Each passes its own caller
enum and any claim refusal to the shared capture writer in
`src/lib/agent/registry.ts`. Host persistence cleanup, delivery controller
cleanup and explicit pipeline termination keep their existing sources and
optional decision behavior.

Opaque turn and orchestration IDs are encoded as `sha256:` followed by the
hex digest of the UTF-8 value, so the journal can be correlated with a known
ID without copying provider text or credentials. Standard kernel process
tokens retain their native format; unexpected string tokens are hashed.
The serializer copies no transcript, message, role, slot, endpoint, account
or path. Caller/refusal/status fields use allowlists. Each fence read is
limited to 4096 bytes from a regular file; the decision is bounded below
12000 UTF-8 bytes by its field and collection limits. The existing journal
rotation keeps a current file and one previous file at a 4 MiB threshold.
Journal append failures retain the existing logged, best-effort behavior.

`src/lib/runtime/registryTerminationDecision.test.ts` exercises the real
caller paths across a simulated succession with an open turn retained on
the row and a proven-dead native root with a live captured descendant. It
also verifies that ordinary succession preserves a live busy native host
without a stop record. `src/lib/agent/structuredTerminationDecision.test.ts`
checks actual journal output through JSON and SQLite capture, fresh ownership
observations, malformed data, privacy and collection limits. These fixtures
do not establish the cause of any historical stop. Observation after an
ordinary deployed succession remains an operations follow-up.
