import { expect, test } from "bun:test";

import { classifySpawnAccountAdmission, liveAccountConversationIds } from "./accountLiveness";
import type { RegistryFile } from "./registry";

const NOW = Date.parse("2026-08-23T15:00:00.000Z");

test("account removal checks retained delivery history once while preserving live evidence", () => {
  const deliveries: Record<string, unknown> = {};
  for (let i = 0; i < 6_000; i++) deliveries[`old-${i}`] = { state: "delivered" };
  deliveries.current = { state: "delivery-uncertain", conversationId: "unrelated", runtimeConversationId: "alias-live",
    createdAt: new Date(NOW).toISOString() };
  deliveries.held = { state: "held", conversationId: "conversation_44", runtimeConversationId: "conversation_44",
    createdAt: new Date(NOW).toISOString() };
  deliveries.expired = { state: "delivery-uncertain", conversationId: "conversation_45", runtimeConversationId: "conversation_45",
    createdAt: new Date(NOW - 600_000).toISOString() };
  let historyReads = 0;
  const heldDeliveries = new Proxy(deliveries, { ownKeys(target) { historyReads++; return Reflect.ownKeys(target); } });
  const conversations: Record<string, unknown> = {};
  for (let i = 0; i < 300; i++) {
    const id = `conversation_${i}`;
    conversations[id] = { id, engine: "claude", generations: [{ accountId: "target", path: `/session/${i}`, host: null }],
      continuityPaths: [], migration: null };
  }
  (conversations["conversation_47"] as { migration: unknown }).migration = { phase: "requested" };
  (conversations["conversation_51"] as { migration: unknown }).migration = { phase: "failed-recoverable" };
  (conversations["conversation_48"] as { generations: unknown[] }).generations = [{ accountId: "target", path: "/session/48",
    host: { tmuxHost: { agent: { pid: 123, startIdentity: "fixture" } } } }];
  (conversations["conversation_50"] as { generations: unknown[] }).generations = [{ accountId: "other", path: "/session/50", host: null }];
  const entries = { live: { key: { engine: "claude" }, status: "live", artifactPath: "/session/49",
    host: { agent: { pid: 123, startIdentity: "fixture" } } } };
  let receiptReads = 0;
  const receipts = new Proxy({ live: { engine: "claude", conversationId: "alias-receipt", state: "starting", key: null,
    createdAt: new Date(NOW).toISOString() } }, { ownKeys(target) { receiptReads++; return Reflect.ownKeys(target); } });
  const file = { conversations, entries, receipts, heldDeliveries,
    conversationAliases: { "alias-live": "conversation_42", "alias-receipt": "conversation_46" } } as unknown as RegistryFile;
  expect(liveAccountConversationIds(file, "claude", "target", {
    now: () => NOW, pidAlive: pid => pid === 123, processIdentity: () => "fixture",
  })).toEqual(["conversation_42", "conversation_46", "conversation_47", "conversation_48", "conversation_49"]);
  expect(historyReads).toBeLessThanOrEqual(2);
  expect(receiptReads).toBeLessThanOrEqual(2);
});

test("spawn admission distinguishes last-known stale evidence from affirmative unavailability", () => {
  const retryAt = "2026-08-23T15:30:00.000Z";

  expect(classifySpawnAccountAdmission({
    enabled: true,
    authentication: "unknown",
    limits: "unknown",
    stale: true,
    retryAt,
  }, NOW)).toEqual({
    kind: "admissible",
    basis: "last-known",
    stale: true,
    retryAt: null,
  });

  expect(classifySpawnAccountAdmission({
    enabled: true,
    authentication: "authenticated",
    limits: "exhausted",
    stale: false,
    retryAt,
  }, NOW)).toEqual({
    kind: "retry-at",
    reason: "hard-limit",
    stale: false,
    retryAt,
  });

  expect(classifySpawnAccountAdmission({
    enabled: true,
    authentication: "failed",
    limits: "unknown",
    stale: false,
    retryAt: null,
  }, NOW)).toEqual({
    kind: "unavailable",
    reason: "auth-failed",
    stale: false,
    retryAt: null,
  });

  expect(classifySpawnAccountAdmission({
    enabled: false,
    authentication: "authenticated",
    limits: "available",
    stale: false,
    retryAt: null,
  }, NOW)).toEqual({
    kind: "unavailable",
    reason: "account-disabled",
    stale: false,
    retryAt: null,
  });
});
