import { expect, test } from "bun:test";
import { projectVoiceDeliveryBodies } from "./voiceBodyProjection";
import { normalizeVoiceDeliveries } from "./voiceDelivery";

const row = (turnId: string, text: string) => normalizeVoiceDeliveries([{
  turnId, ready: true, responses: [{ responseId: "shared-response", text }],
}])[0]!;

test("response bodies remain scoped to their turn and never introduce recovered membership", () => {
  const current = row("current-turn", "");
  expect(projectVoiceDeliveryBodies([current], [row("other-turn", "Other text")], new Set()))
    .toEqual({ deliveries: [], complete: false });
  const recovered = row("current-turn", "Canonical text");
  expect(projectVoiceDeliveryBodies([current], [recovered, row("unrelated-turn", "Unrelated text")], new Set()).deliveries)
    .toEqual([recovered]);
  expect(projectVoiceDeliveryBodies([], [recovered], new Set())).toEqual({ deliveries: [], complete: true });
  expect(projectVoiceDeliveryBodies([current], [recovered], new Set([current.deliveryId])))
    .toEqual({ deliveries: [], complete: true });
});

test("live text wins and missing or empty recovered bodies cannot produce a partial delivery", () => {
  const current = row("turn", "Live text");
  expect(projectVoiceDeliveryBodies([current], [row("turn", "Older text")], new Set()).deliveries).toEqual([current]);
  const missing = row("missing", "");
  expect(projectVoiceDeliveryBodies([current, missing], [missing], new Set())).toEqual({ deliveries: [], complete: false });
});
