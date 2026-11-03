# Resuming a structured host after its Viewer exits

Send the next message to the existing conversation. Recovery reserves that
message under its original delivery key, resumes the native session and lets
the durable queue deliver it. It can run independently of the general startup
adoption pass, subject to the existing restart-cut and delivery admission fences.

An `idle` registry row can outlive both its recorded Viewer writer and its
engine. Retained scope metadata still fences a replacement even after the
scope itself disappears. Before retrying a refused claim, targeted recovery
uses the existing structured termination ladder to retire that custody:

- A nonterminal row qualifies only when its recorded engine is proven dead.
- A live or unverifiable claim owner keeps its claim. A missing claim needs
  no owner retirement; an unrecognized claim is refused.
- The exact recorded scope and every retained descendant must be confirmed
  ended before their metadata is removed. Surviving descendants keep fencing
  the replacement, as required by the terminal orphan protection.
- Owner, claim epoch, writer epoch, operation, process and scope remain bound
  to the original row across asynchronous cleanup. A changed row refuses
  retirement. The subsequent claim checks ownership again under the registry
  mutation lock.

Unscoped dead-host reconciliation also preserves live or unverifiable writers.
Health and delivery readiness share the registry process-evidence verdict in
`src/lib/lifecycle/owners.ts`. Stored process columns alone cannot establish
that a gone host can receive a message.

## Deferred transport continuity

Continuous Claude execution across a Viewer replacement remains deferred.
Its stdio belongs to the Viewer process, so loss of that connection can end
the engine. EOF is the leading explanation for the diagnosed exits, without
a retained direct EOF trace. Keeping the engine connected requires transport
custody independent of the replacing Viewer, comparable to the persistent
Codex socket path. This change provides safe next-message recovery. A Viewer
exit alone never proves its engines or their descendants have exited.
