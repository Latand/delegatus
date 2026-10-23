import { expect, test } from "bun:test";
import { normalizeRegistry, type RegistryFile } from "@/lib/agent/registry";
import { deliveryDedupToken } from "@/lib/runtime/deliveryDedup";
import { MEMORY_DELIVERY_EVIDENCE_LIMIT, memoryDeliveryEvidence, memoryDeliveryForToken } from "./deliveryEvidence";

function fixture(count: number) {
  const file = normalizeRegistry({ version: 2, entries: {}, receipts: {}, deliveryOperationOwners: Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`operation-${index}`, { conversationId: index ? "conversation_other" : "conversation_target",
      clientMessageId: `message-${index}`, deliveryId: `delivery-${index}`, requestDigest: `digest-${index}`,
      command: { operationId: `operation-${index}`, origin: { kind: "operator" } }, createdAt: "2026-10-01T00:00:00.000Z" }])) });
  return file;
}

test("structured token lookup selects the authenticated conversation and operation", () => {
  const file = fixture(3);
  expect(memoryDeliveryForToken(file, "conversation_target", deliveryDedupToken("operation-0"))?.command.operationId).toBe("operation-0");
  expect(memoryDeliveryForToken(file, "conversation_target", deliveryDedupToken("operation-1"))).toBeUndefined();
  expect(memoryDeliveryForToken(file, "conversation_target", deliveryDedupToken("missing"))).toBeUndefined();
});

test("native evidence is scoped to the conversation while relay evidence covers other senders", () => {
  const file = fixture(3);
  expect(memoryDeliveryEvidence(file, "conversation_target", false)?.owners.map(row => row.command.operationId)).toEqual(["operation-0"]);
  expect(memoryDeliveryEvidence(file, "conversation_target", true)?.owners).toHaveLength(3);
  file.deliveryOperationOwners["operation-0"]!.terminalDisposition = "lost";
  expect(memoryDeliveryEvidence(file, "conversation_target", false)?.owners[0]?.terminalDisposition).toBe("lost");
});

test("over-budget relay evidence stays unproven before any payload is accessed", () => {
  const file = fixture(MEMORY_DELIVERY_EVIDENCE_LIMIT + 1);
  for (const key of Object.keys(file.deliveryOperationOwners)) Object.defineProperty(file.deliveryOperationOwners, key, {
    enumerable: true, get: () => { throw new Error("unbounded payload hydration"); },
  });
  expect(memoryDeliveryEvidence(file, "conversation_target", true)).toBeNull();
});

test("the native delivery bound also covers held payloads", () => {
  const file = fixture(0);
  file.heldDeliveries = Object.fromEntries(Array.from({ length: MEMORY_DELIVERY_EVIDENCE_LIMIT + 1 }, (_, index) =>
    [`delivery-${index}`, { conversationId: "conversation_target" }])) as unknown as RegistryFile["heldDeliveries"];
  expect(memoryDeliveryEvidence(file, "conversation_target", false)).toBeNull();
});

test("a fresh process applies the same evidence bound without a warm cache", async () => {
  const script = `const { memoryDeliveryEvidence, MEMORY_DELIVERY_EVIDENCE_LIMIT } = await import(${JSON.stringify(new URL("./deliveryEvidence.ts", import.meta.url).href)});
    const file = { deliveryOperationOwners: {}, heldDeliveries: {} };
    for (let index = 0; index <= MEMORY_DELIVERY_EVIDENCE_LIMIT; index++) Object.defineProperty(file.deliveryOperationOwners, 'operation-' + index,
      { enumerable: true, get() { throw new Error('payload must stay unread'); } });
    console.log(JSON.stringify(memoryDeliveryEvidence(file, 'conversation_target', true)));`;
  for (let restart = 0; restart < 2; restart++) {
    const child = Bun.spawn([process.execPath, "--eval", script], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stdout: stdout.trim(), stderr }).toEqual({ code: 0, stdout: "null", stderr: "" });
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  }
});
