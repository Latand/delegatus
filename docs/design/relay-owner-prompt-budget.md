# Owner relay prompt budget

Reply to the message that supplies the subject of the request. The relay keeps
the current intent, full explicit reply chain, owner and service instructions,
required documents, inbound media access and tool identities within the
32,000-byte structured message envelope. If these required inputs cannot fit,
the relay returns a readable size refusal before dispatching that prompt.
Shortening or splitting the request and required quotations can resolve it.

`prepareOwnerPrompt` and `ownerContinuationPrompt` return the actual prompt,
its delivered message IDs and the digest of its selected static sections.
The runner passes this result to dispatch and cursor persistence together.
A fresh chain prepares only its initial prompt. A resumed native conversation
uses its existing seen IDs and exact answer witness.

The full explicit quote occurs once, on its conversation row.
`owner_reply_context` retains IDs and reply links. The current conversation
row references `owner_request.text` when its text is identical. Confirmed local
rows replace service copies by ID. An exact match between a confirmed bridge
report and its explicit parent references `bridge_report.reportText` instead
of repeating that text. Authorship, timestamps, media refs and routing stay.

When the complete render is too large, selection removes unrelated history,
memory, unrelated documents and display summaries. It measures the escaped
JSON, section tags and separators after each selection. Explicit reply links
and local question groups remain protected. Requested text and instructions
are never excerpted to make room. The optional suffix is appended after
selection and is dropped if it would exceed the bound.

Only the prompt projection loses tool summaries. When summaries are exhausted,
the tool index uses explicit columns and rows to avoid repeating column names.
The original hydrated request still supplies list/describe/call, full schemas,
guidance, audience filtering and action admission to the existing adapter.

Inbound media manifests and trust rules are mandatory additions. Cloud owner
rounds add their current answer frame and tool results separately from the
duplicated conversation. Confirmed Cloud fallback prepares the native delivery
mode again and retains prior tool results. Existing authorization, uncertainty,
fallback and completion guards remain responsible for effects.
Size refusals retain the earlier action's completed, unknown or confirmation
status in the answer and additive diagnostic metadata. They preserve the
existing action ledger and do not retry that action.

The accepted design and its historical evidence limits are recorded unchanged
in [the repair plan](relay-envelope-repair-plan.md) and
[the incident trace](relay-current-incident-trace.md). The synthetic fixtures
exercise the recorded input sizes; they do not reconstruct missing historical
hydration responses. This change makes no performance claim.
