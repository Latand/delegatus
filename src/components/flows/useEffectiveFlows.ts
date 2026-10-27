"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { Flow, FlowState } from "@/lib/flows/types";

/*
 * Flows closed in this tab but possibly not yet reflected by the /api/files
 * poll (10 s cadence). The close click must clear the reviewer side of the
 * scheme instantly, so consumers overlay this set on the polled flows via
 * useEffectiveFlows. Entries become redundant once the server confirms; the
 * set stays tiny (ids of flows closed this session).
 */
const locallyClosed = new Set<string>();
let locallyClosedSnapshot: ReadonlySet<string> = locallyClosed;
const closeListeners = new Set<() => void>();

export function markFlowClosedLocally(id: string): void {
  if (locallyClosed.has(id)) return;
  locallyClosed.add(id);
  locallyClosedSnapshot = new Set(locallyClosed);
  for (const listener of closeListeners) listener();
}

function subscribeLocallyClosed(listener: () => void): () => void {
  closeListeners.add(listener);
  return () => closeListeners.delete(listener);
}

const locallyClosedServerSnapshot: ReadonlySet<string> = new Set();

/**
 * The polled flows with this tab's optimistic closes applied: a flow closed
 * here renders as closed the moment the X is clicked, and the poll catches
 * up later. The overlay maps the flow's state to closed while keeping the
 * flow in the list, so reviewer transcripts stay claimed by their rounds and
 * never resurface as standalone nodes.
 */
export function useEffectiveFlows(flows: Flow[]): Flow[] {
  const closed = useSyncExternalStore(
    subscribeLocallyClosed,
    () => locallyClosedSnapshot,
    () => locallyClosedServerSnapshot,
  );
  return useMemo(() => {
    if (!flows.some((flow) => closed.has(flow.id) && flow.state !== "closed")) return flows;
    return flows.map((flow) =>
      closed.has(flow.id) && flow.state !== "closed"
        ? { ...flow, state: "closed" as FlowState, closedAt: flow.closedAt ?? new Date().toISOString() }
        : flow,
    );
  }, [flows, closed]);
}
