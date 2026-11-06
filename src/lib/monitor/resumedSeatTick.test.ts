import { expect, test } from "bun:test";
import { requestResumedSeatTick } from "./resumedSeatTick";

test("a resumed current seat rechecks its project immediately", async () => {
  const checked: string[] = [];
  await requestResumedSeatTick("current", { seats: () => [{ state: "active", conversationId: "current", project: "project" }],
    check: async project => { checked.push(project); } });
  expect(checked).toEqual(["project"]);
});

test("a resumed worker or former seat cannot wake another seat", async () => {
  const checked: string[] = [];
  await requestResumedSeatTick("previous", { seats: () => [{ state: "active", conversationId: "current", project: "project" }],
    check: async project => { checked.push(project); } });
  expect(checked).toEqual([]);
});

test("concurrent resumes share one check and a failed check permits a later retry", async () => {
  const gate = Promise.withResolvers<void>();
  let checks = 0;
  const dependencies = { seats: () => [{ state: "active", conversationId: "coalesced", project: "project" }],
    check: async () => { checks++; await gate.promise; throw new Error("check unavailable"); } };
  const first = requestResumedSeatTick("coalesced", dependencies);
  const second = requestResumedSeatTick("coalesced", dependencies);
  expect(second).toBe(first);
  gate.resolve();
  await expect(first).rejects.toThrow("check unavailable");
  await expect(second).rejects.toThrow("check unavailable");
  await requestResumedSeatTick("coalesced", { ...dependencies, check: async () => { checks++; } });
  expect(checks).toBe(2);
});
