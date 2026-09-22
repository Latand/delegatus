import { useEffect, useMemo, useState } from "react";

import type { DeliveredMessageProvenance } from "@/lib/runtime/messageOrigin";
import { structuredUserProvenance } from "@/lib/selection/structuredUserMetadataAction";
import type { FeedEntry, Item } from "./parse";

/** Bind metadata only by the marker's immutable reference. Never fall back to
 * matching text, time, or the currently selected card for a compact record. */
export function structuredProvenanceForItem(
  item: Item,
  records: Readonly<Record<string, DeliveredMessageProvenance | null>>,
): DeliveredMessageProvenance | null {
  return item.structuredUserRef ? records[item.structuredUserRef] ?? null : null;
}

export function useStructuredUserProvenance(items: readonly FeedEntry[]) {
  const key = [...new Set(items.flatMap(({ item }) => item.structuredUserRef ? [item.structuredUserRef] : []))].sort().join("\n");
  const [records, setRecords] = useState<Record<string, DeliveredMessageProvenance | null>>({});
  useEffect(() => {
    let alive = true;
    const refs = key ? key.split("\n") : [];
    // Keep state bounded by the rendered window; metadata is already durable
    // before the transcript can appear, so no polling is needed.
    void (async () => {
      const next: Record<string, DeliveredMessageProvenance | null> = {};
      for (let offset = 0; offset < refs.length && alive; offset += 100) {
        try { Object.assign(next, await structuredUserProvenance(refs.slice(offset, offset + 100))); }
        catch { /* An unavailable reference leaves its own row unattributed. */ }
      }
      if (alive) setRecords(next);
    })();
    return () => { alive = false; };
  }, [key]);
  return useMemo(() => (item: Item) => structuredProvenanceForItem(item, records), [records]);
}
