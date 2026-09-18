import type { RuntimeVoiceDelivery } from "./voiceDelivery";

/** A delivery id names a response set and changes as that set grows. Bodies
 * belong to a turn/response pair. Current membership/order and delivery ids
 * remain authoritative; recovery only fills their missing text. This index
 * lives for one projection within the caller's conversation/revision scope. */
export function projectVoiceDeliveryBodies(
  current: readonly RuntimeVoiceDelivery[],
  recovered: readonly RuntimeVoiceDelivery[],
  acknowledged: ReadonlySet<string>,
): { deliveries: RuntimeVoiceDelivery[]; complete: boolean } {
  const turns = new Map<string, Map<string, string>>();
  for (const delivery of recovered) {
    let responses = turns.get(delivery.turnId);
    if (!responses) turns.set(delivery.turnId, responses = new Map());
    for (const response of delivery.responses) if (response.text) responses.set(response.responseId, response.text);
  }
  let complete = true;
  const deliveries = current.filter(delivery => !acknowledged.has(delivery.deliveryId)).map(delivery => ({
    ...delivery,
    responses: delivery.responses.map(response => {
      const text = response.text || turns.get(delivery.turnId)?.get(response.responseId);
      if (text === undefined) complete = false;
      return text === undefined ? response : { ...response, text };
    }),
  }));
  // Never hand a caller a partially hydrated payload it could accidentally ack.
  return { deliveries: complete ? deliveries : [], complete };
}
