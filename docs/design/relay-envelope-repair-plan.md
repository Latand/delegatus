# Relay replies with large quoted context

Reply to a message with the instruction you want carried out. The relay keeps
that instruction in the structured envelope. When the complete required context
exceeds 32 000 UTF-8 bytes, the native agent receives a request-local context
file and reads it before answering. The file contains the complete direct
quotation, reply chain, service data, tool index, bridge report and required
media additions. A reply to an earlier failure follows this same path.

Only an instruction that cannot fit in its framed envelope receives the size
refusal. The reply asks for the instruction itself to be shortened or split.
Storage, authority or execution failures retain their existing failure paths.

## Composition and delivery

`prepareOwnerPrompt` and `ownerContinuationPrompt` first run the existing
`boundedRelayPrompt` selection. Exact duplicate text is represented once;
optional history, memory, unrelated documents and tool summaries may yield.
An optional suffix is appended only after that selection and only if it fits.
The existing tests for direct-quote and bridge-report facts keep their full
text assertions.

If the required composition still exceeds the bound, `boundedOwnerPrompt`
renders the original canonical input and mandatory additions in full. It
returns that framed message as `PreparedOwnerPrompt.context`, with a small
inline prompt containing the current `owner_request` and instructions to read
the context file. The optional suffix is excluded. Both renderings preserve
the distinction between the current instruction and quoted/service data.
The current instruction and `request_text` remain verbatim in the envelope.
The direct parent and older rows remain verbatim in the file; no excerpt
replaces their text.

`runOwnerAgent` asynchronously writes the full context before either launch
or continuation. Its filename is generated locally; exclusive creation and
mode 600 protect it from replacement or accidental publication. Production
uses a private relay run directory under `$HOME/.cache/delegatus/relay-runs`,
alongside inbound media. HOME is mounted at the same absolute path in the
Viewer container and the native host namespace; container `/tmp` is private
and cannot carry these files. State and cache environment overrides may also
point outside the shared mount, so they do not select this root. The same
custody and cleanup that retain that directory during execution and stop
recovery retain this file. A standalone caller without run custody receives
a private directory under the same shared root, removed after its turn or
confirmed stop. The orphan sweep accepts both the shared root and the older
temporary run root for cleanup. Context files never enter a worktree.
An I/O failure prevents dispatch. Authority is checked again after the write,
and the normal synchronous launch/continuation guards still apply.

The file path is JSON encoded in the delivered envelope. The final
`assertStructuredTextEnvelope` checks the actual text, including that path,
before dispatch. The 32 000-byte transport bound is unchanged. The first
message and resumed messages use the same file mechanism.

File delivery alone grants no read receipt: only the current inline owner
message is recorded in `seen`, and `external-context` does not match an inline
static digest. Later turns therefore cannot suppress unread rows or static
sections on the strength of a file pointer. Existing answer-witness checks
remain in place.

## Tools, media and Cloud

The file contains the tool metadata and required inbound manifest. The
original hydrated request remains owned by the existing `relay_service_tools`
adapter; describe/call, audience filtering, confirmation, effect deduplication
and authorization keep their existing checks. A large bridge report or
extracted document uses the same context file without losing its contents.

A Cloud environment cannot read a local relay file. Before starting a remote
turn for an overflowing prompt, `runner.ts` selects the existing native
fallback, checks the configured repository and resolves a local account.
Normal Cloud prompts continue remotely. If overflow follows a Cloud tool
round, the fallback receives the previous tool results and shares the same
adapter and effect budget. Completed, unknown and confirmation-pending
actions are preserved; they are never resubmitted by the fallback machinery.
A missing repository or local account retains the existing configuration or
capacity failure instead of dispatching a broken file pointer remotely.

The historical reference to `delivery.ts` described an older implementation.
On the current base, that module delegates to structured message delivery and
provides no reusable first-launch large-text transport. Relay-local files
use the same full-file handoff pattern as `composeStructuredFirstMessage`
without its pipeline worktree artifact namespace or a new retrieval service.

## Evidence and acceptance

The live journal recorded mandatory sizes 33 474 and 34 090 with a limit of
32 000. Stored input reconstruction identifies escaped owner instructions
15 494, service instructions 3 027, format 1 486, tool identities 4 145, and
protected conversation 2 799 / 3 440. These are numeric measurements only.
The original final prompts, hydrated catalog responses and full answer controls
were not retained; the reconstructed totals 32 402 / 33 018 are separate from
the journal totals. Private source records and reconstruction details remain
outside the repository.

`ownerEnvelope.test.ts` exercises both launch and continuation, reads the real
context file at the dispatch boundary, and returns an answer through the
owner result path. Synthetic cases cover several 4 096-character Cyrillic
ancestors, a reply to a failure, aggregate service/tool pressure, a full
16 000-character direct parent, escaping, media additions and bridge facts.
An instruction of 32 002 UTF-8 bytes refuses before either dispatch path.
Write failure and authority replacement after the file write also prevent
dispatch. Cloud action-result cases prove one effect followed by one native
answer for completed, unknown and confirmation-pending results.

Tests run by explicit file in a scratch export with isolated HOME,
XDG_CONFIG_HOME, TMPDIR, LLV_STATE_DIR and a closed Viewer control endpoint.
The stage additionally runs typecheck and the publication gate. Live sends,
replays, state changes and deployment are outside this repair stage.
