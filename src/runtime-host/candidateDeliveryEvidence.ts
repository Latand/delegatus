/* The candidate performance gate's delivery evidence (#2761,
   docs/design/candidate-performance-gate.md, "Evidence"): the retained
   delivery rows and pending launch receipts of the synthetic registry must
   leave the release run as they entered it, and an open delivery must stay
   hot. Speed bought by dropping evidence is a regression no latency bound sees.

   One write is the product's own and is accepted: settlement ends an open
   delivery whose recipient is proven dead
   (docs/design/delivery-terminal-waits.md: "A proven target death also makes
   settlement due"). Its background sweep writes `state: "failed"` with one of
   its own terminal reasons and nothing else, and the archive pass may then
   archive the terminal row. Every other change, and that same write on a
   delivery whose recipient was not proven dead in the seeded registry, is
   still lost evidence. */

import type { Database } from "bun:sqlite";

import {
  SEND_LOST_REASON,
  SEND_UNRECORDED_REASON,
  SEND_UNSETTLEABLE_REASON,
  SEND_UNVERIFIED_REASON,
} from "@/lib/runtime/sendSettlement";

/** A registry row as the gate reads it, with whether `registry_cold` maps it. */
export interface StoredRegistryRow {
  json: string;
  cold: boolean;
}

/** The reasons send settlement writes when it ends a wait on its own deadline. */
const SETTLEMENT_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  SEND_LOST_REASON,
  SEND_UNVERIFIED_REASON,
  SEND_UNRECORDED_REASON,
  SEND_UNSETTLEABLE_REASON,
]);
const OPEN_DELIVERY_STATES: ReadonlySet<string> = new Set(["held", "assigned", "delivery-uncertain"]);

/**
 * The deliveries among `ids` whose recipient the registry holds proven dead:
 * the entry of the conversation's current generation is `dead` and records no
 * process, which is how settlement's `recipientProvenDead` reads a row without
 * a process identity. A recorded process is never counted, so its deliveries
 * stay under the byte-identical comparison.
 */
export function deadRecipientDeliveryIds(db: Database, ids: readonly string[]): Set<string> {
  const query = db.query<{ dead: number }, [string]>(`SELECT EXISTS (
      SELECT 1 FROM registry_records d
        JOIN registry_records c ON c.collection='conversations' AND c.row_key=json_extract(d.value_json,'$.conversationId')
        JOIN registry_records e ON e.collection='entries'
          AND e.row_key=json_extract(c.value_json,'$.engine') || ':' || json_extract(c.value_json,'$.generations[#-1].id')
      WHERE d.collection='heldDeliveries' AND d.row_key=?
        AND json_extract(e.value_json,'$.status')='dead'
        AND json_extract(e.value_json,'$.structuredHost.process') IS NULL) AS dead`);
  return new Set(ids.filter((id) => query.get(id)?.dead === 1));
}

/** Settlement's terminal write on an open delivery, and no other change. */
function settledByDeadline(before: string, after: string): boolean {
  const seeded = JSON.parse(before) as Record<string, unknown>;
  const current = JSON.parse(after) as Record<string, unknown>;
  if (typeof seeded.state !== "string" || !OPEN_DELIVERY_STATES.has(seeded.state)) return false;
  if (current.state !== "failed" || typeof current.error !== "string" || !SETTLEMENT_TERMINAL_REASONS.has(current.error)) return false;
  const rest = (row: Record<string, unknown>) => JSON.stringify({ ...row, state: undefined, error: undefined });
  return rest(seeded) === rest(current);
}

export interface DeliveryEvidenceInput {
  /** Pending and uncertain deliveries: identical and hot, or settled on a dead recipient. */
  openIds: readonly string[];
  /** Every delivery row of the registry: identical, or settled on a dead recipient. */
  retainedIds: readonly string[];
  /** Pending launch receipts: identical. */
  launchIds: readonly string[];
  /** Open deliveries whose recipient was proven dead before the run. */
  deadRecipientIds: ReadonlySet<string>;
  deliveriesBefore: ReadonlyMap<string, StoredRegistryRow>;
  deliveriesAfter: ReadonlyMap<string, StoredRegistryRow>;
  launchesBefore: ReadonlyMap<string, StoredRegistryRow>;
  launchesAfter: ReadonlyMap<string, StoredRegistryRow>;
}

export interface DeliveryEvidenceVerdict {
  preserved: boolean;
  /** Open deliveries ended by settlement because their recipient was dead. */
  settledOnDeadRecipients: number;
  /** Rows that changed in any other way, by collection and key. */
  changed: string[];
}

export function deliveryEvidenceVerdict(input: DeliveryEvidenceInput): DeliveryEvidenceVerdict {
  const changed: string[] = [];
  const settled = new Set<string>();
  const delivery = (id: string, open: boolean) => {
    const before = input.deliveriesBefore.get(id);
    const after = input.deliveriesAfter.get(id);
    if (!before || !after) return false;
    if (before.json === after.json) return !open || !after.cold;
    if (input.deadRecipientIds.has(id) && settledByDeadline(before.json, after.json)) {
      settled.add(id);
      return true;
    }
    return false;
  };
  for (const id of input.openIds) if (!delivery(id, true)) changed.push(`heldDeliveries/${id}`);
  for (const id of input.retainedIds) if (!delivery(id, false) && !changed.includes(`heldDeliveries/${id}`)) changed.push(`heldDeliveries/${id}`);
  for (const id of input.launchIds) {
    const before = input.launchesBefore.get(id);
    if (!before || before.json !== input.launchesAfter.get(id)?.json) changed.push(`receipts/${id}`);
  }
  return { preserved: changed.length === 0, settledOnDeadRecipients: settled.size, changed };
}
