import { expect, test } from "bun:test";

import type { Flow, Round } from "@/lib/flows/types";

import { relayClientMessageId } from "./relayIdentity";

function flowWith(rounds: Partial<Round>[] = []): Flow {
  return { id: "flow-history", rounds } as Flow;
}

test("legacy rows preserve their identity without a round or reviewer binding", () => {
  expect(relayClientMessageId(flowWith())).toBe("flow_relay_badffdce4dc7f2dd66dac8b71f1cc262");
  expect(relayClientMessageId(flowWith([{ n: 3 }]))).toBe("flow_relay_533def39d452b793c4fb5bf60de80ad1");
});

test("a bound round keeps the same identity for an absent or zero delivery attempt", () => {
  const round = { n: 3, reviewerBindingId: "binding-3" };
  expect(relayClientMessageId(flowWith([round]))).toBe("flow_relay_875d0ad86e8ab1049ff7b3bcb11cd401");
  expect(relayClientMessageId(flowWith([{ ...round, relayDeliveryAttempt: 0 }]))).toBe("flow_relay_875d0ad86e8ab1049ff7b3bcb11cd401");
});

test("a retry preserves the delivery reservation identity", () => {
  expect(relayClientMessageId(flowWith([
    { n: 3, reviewerBindingId: "binding-3", relayDeliveryAttempt: 2 },
  ]))).toBe("flow_relay_148206a4e65258eba9d8d141fa471f64");
});

test("an explicit historical round uses its own identity while the default uses the last round", () => {
  const flow = flowWith([
    { n: 3, reviewerBindingId: "binding-3", relayDeliveryAttempt: 2 },
    { n: 7, reviewerBindingId: "binding-7" },
  ]);
  const before = JSON.stringify(flow);
  expect(relayClientMessageId(flow, flow.rounds[0])).toBe("flow_relay_148206a4e65258eba9d8d141fa471f64");
  expect(relayClientMessageId(flow)).toBe("flow_relay_f6563cca76f56506b824dc7e949ac573");
  expect(JSON.stringify(flow)).toBe(before);
});
