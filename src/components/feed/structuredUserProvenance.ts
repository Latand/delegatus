import { useEffect, useMemo, useRef, useState } from "react";

import type { DeliveredMessageProvenance } from "@/lib/runtime/messageOrigin";
import { structuredUserProvenance } from "@/lib/selection/structuredUserMetadataAction";
import type { FeedEntry, Item } from "./parse";

const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1_500, 4_000, 10_000];
let retryDelaysMs = DEFAULT_RETRY_DELAYS_MS;

export function setStructuredUserRetryScheduleForTests(delays: readonly number[] | null): void {
  retryDelaysMs = delays ?? DEFAULT_RETRY_DELAYS_MS;
}

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
  const retained = useRef<Record<string, DeliveredMessageProvenance | null>>({});
  const [records, setRecords] = useState(retained.current);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refs = key ? key.split("\n") : [];
    const delays = retryDelaysMs;
    // Metadata is immutable. Retain answers for the current window, including
    // explicit null (a missing handle), and fetch only unanswered references.
    retained.current = Object.fromEntries(refs.filter((ref) => Object.hasOwn(retained.current, ref))
      .map((ref) => [ref, retained.current[ref]]));
    setRecords(retained.current);
    const attempt = async (pending: string[], retry: number) => {
      const failed: string[] = [];
      for (let offset = 0; offset < pending.length && alive; offset += 100) {
        const batch = pending.slice(offset, offset + 100);
        try {
          const answer = await structuredUserProvenance(batch);
          if (!alive) return;
          const next = { ...retained.current };
          for (const ref of batch) {
            if (Object.hasOwn(answer, ref) && answer[ref] !== undefined) next[ref] = answer[ref];
            else failed.push(ref);
          }
          retained.current = next;
          setRecords(next);
        } catch {
          // A failed request says nothing about earlier successful answers.
          // Retry only these references, without requiring a new render/key.
          failed.push(...batch);
        }
      }
      if (alive && failed.length && retry < delays.length) {
        timer = setTimeout(() => void attempt(failed, retry + 1), delays[retry]);
      }
    };
    void attempt(refs.filter((ref) => !Object.hasOwn(retained.current, ref)), 0);
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [key]);
  return useMemo(() => (item: Item) => structuredProvenanceForItem(item, records), [records]);
}
