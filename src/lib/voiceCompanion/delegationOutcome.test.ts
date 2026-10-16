import { expect, test } from "bun:test";
import { delegationSpeech, deliveryFact, nothingSent, speakable, type DeliveryFact } from "./delegationOutcome";

test("non-sent results explicitly say nothing was sent without repeating an existing opening", () => {
  for (const speech of ["Nothing was sent. Refused.", "Nothing has been sent yet.", "Nothing new was sent."])
    expect(nothingSent({ status: "refused", speech })).toEqual({ status: "refused", speech, sent: false });
  expect(nothingSent({ status: "failed", speech: "Unavailable." })).toEqual({ status: "failed", sent: false, speech: "Nothing was sent. Unavailable." });
  expect(nothingSent({ status: "sent", speech: "Sent." })).toEqual({ status: "sent", speech: "Sent." });
});

test("delivery facts cover every unsent status and leave fresh report reads alone", () => {
  for (const status of ["refused", "failed", "too_long", "check_waiting", "nothing_waiting"])
    expect(deliveryFact({ status, reason: "Unavailable." })?.speech.toLowerCase()).toContain("nothing was sent");
  expect(deliveryFact({ status: "sent", delivery: "failed" })?.kind).toBe("nothing");
  for (const status of ["answered", "awaiting_report"]) expect(deliveryFact({ status })).toBeNull();
});

test("a failed last send suppresses the model's claim, a confirmation keeps its question, and success carries its state", () => {
  const failed = deliveryFact({ status: "refused", reason: "No recipient." })!;
  const awaiting = deliveryFact({ status: "awaiting_confirmation", instruction: "Review the plan", reason: "Confirm scope." })!;
  const sent = deliveryFact({ status: "sent", delivery: "queued" })!;
  expect(delegationSpeech("Yes, I passed it on.", [failed])).toBe("Nothing was sent. No recipient.");
  expect(delegationSpeech("Yes, I passed it on.", [failed, awaiting])).toBe(`${failed.speech} ${awaiting.speech}`);
  expect(awaiting.speech).toBe("Nothing has been sent. I would send: Review the plan. Confirmation reason: Confirm scope. Ask the operator whether to send it; their spoken yes or no or the card's buttons will confirm.");
  expect(delegationSpeech("Done.", [sent, failed])).toBe(`Done. ${sent.speech} ${failed.speech}`);
  expect(delegationSpeech("A fresh report.", [])).toBe("A fresh report.");
});

test("UTF-8 facts keep their room and the 500-byte bound holds even with many failures", () => {
  for (const delivery of ["queued", "delivered", "unknown"]) {
    const fact = deliveryFact({ status: "sent", delivery })!;
    const speech = delegationSpeech("Довга відповідь. ".repeat(100), [fact]);
    expect(Buffer.byteLength(speech)).toBeLessThanOrEqual(500);
    expect(speech.endsWith(fact.speech)).toBe(true);
    expect(speech).not.toContain("�");
  }
  const facts: DeliveryFact[] = [deliveryFact({ status: "sent", delivery: "queued" })!,
    ...Array.from({ length: 12 }, (_, i) => ({ kind: "nothing" as const, speech: `Nothing was sent. Reason ${i}: ${"failure ".repeat(30)}` }))];
  expect(Buffer.byteLength(delegationSpeech("Done.", facts))).toBeLessThanOrEqual(500);
  expect(delegationSpeech("Done.", facts)).toContain("The request is queued for the orchestrator.");
  const awaiting = deliveryFact({ status: "awaiting_confirmation", instruction: "ї".repeat(500), reason: "я".repeat(300) })!;
  const confirmation = delegationSpeech("I passed it to the orchestrator.", [awaiting]);
  expect(Buffer.byteLength(confirmation)).toBeLessThanOrEqual(500);
  expect(confirmation).toContain("Nothing has been sent.");
  expect(confirmation).toContain("spoken yes or no");
  expect(confirmation).not.toContain("I passed it");
  for (const limit of [0, 1, 10, 80, 500]) expect(Buffer.byteLength(speakable("я".repeat(600), limit))).toBeLessThanOrEqual(limit);
});
