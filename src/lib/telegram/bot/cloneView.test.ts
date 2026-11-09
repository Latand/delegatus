import { expect, test } from "bun:test";
import { clonePairing } from "@/lib/externalRelay/clone.fixture";
import { cloneMethodLimits, cloneMethodRights } from "@/lib/externalRelay/cloneMethods.fixture";
import type { CloneRoute } from "@/lib/externalRelay/cloneDirectory";
import { cloneChatView } from "./clone";

const relay = clonePairing("http://127.0.0.1:1");
const route = (extra: Partial<CloneRoute> = {}): CloneRoute => ({ id: "route", relay, targetId: "fixture-clone", name: "Report clone", ...extra });

test("a text-only clone reads as a clone of its relay", () => {
  expect(cloneChatView(route())).toMatchObject({ name: "Report clone", clone: { relay: "Fixture relay" }, canPost: true });
});

test("a methods-feature clone still reads as a clone, with its rights", () => {
  expect(cloneChatView(route({ methodsFeature: true, send: { limits: cloneMethodLimits(), rights: cloneMethodRights() } })))
    .toMatchObject({ clone: { relay: "Fixture relay" }, member: true, canPost: true, canSendDocuments: true });
});

test("a methods-feature clone with unread rights keeps the clone and an unknown post right", () => {
  const limits = { ...cloneMethodLimits(), methods: ["sendPhoto"] };
  expect(cloneChatView(route({ methodsFeature: true, send: { limits, rights: null } })))
    .toMatchObject({ clone: { relay: "Fixture relay" }, canPost: null, reason: null });
});
