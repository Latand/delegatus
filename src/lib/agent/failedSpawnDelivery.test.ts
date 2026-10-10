import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";

import { emptyLaunchProfile, type HeldDelivery } from "@/lib/accounts/migration/contracts";
import { runReaperCycle } from "@/lib/reaperRuntime";

import { AgentRegistry } from "./registry";
import { conversationIsLive, livenessProbe } from "./accountLiveness";
import { projectLaunchConversations } from "./spawnProjection";

const originalStateDir = process.env.LLV_STATE_DIR;
afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
});

/**
 * Issue #653, defect 2: a held delivery whose spawn receipt reached the terminal
 * `failed` state can never deliver its first message, yet its `spawn_<launchId>`
 * reservation stays `held` forever — it keeps counting as an owed delivery and
 * keeps the ghost "delivering" bubble alive. The registry must terminalize it
 * durably (failed), race-safe against a concurrent delivery attempt (only a
 * still-`held` reservation is touched).
 */

interface FailedSpawnFixture {
  registry: AgentRegistry;
  launchId: string;
  conversationId: string;
  deliveryId: string;
  dir: string;
}

/** A structured launch that failed at 08:07Z with its initial `spawn_<launchId>`
    message still `held`, attempts 0 — the exact production shape from the issue. */
function makeFailedSpawnWithHeldDelivery(): FailedSpawnFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-failed-spawn-delivery-"));
  const filename = path.join(dir, "agent-registry.json");
  const cwd = path.join(dir, "pipeline-f9424665");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
  /* The reviewer conversation exists (it materialized a transcript) but its host
     is gone; only the stuck initial delivery keeps it "owed". */
  const conversation = registry.ensureConversation("claude", path.join(cwd, "reviewer.jsonl"), "acctA");
  const begun = registry.beginSpawnRequest({
    engine: "claude",
    cwd,
    transport: "structured",
    accountId: "acctA",
    conversationId: conversation.id,
    launchProfile: emptyLaunchProfile({ cwd, title: "Review the requested change" }),
    launchDisplay: { prompt: "Round 2 review PR #618", images: 0, echo: "Round 2 review PR #618" },
  });
  if (begun.kind !== "created") throw new Error("expected structured launch creation");
  const { launchId, conversationId } = begun.receipt;
  registry.failStructuredSpawn(launchId, "spawn failed");

  const deliveryId = "held-6244ae52";
  const snapshot = registry.snapshot();
  snapshot.heldDeliveries[deliveryId] = {
    id: deliveryId,
    conversationId,
    runtimeConversationId: conversationId,
    text: "Round 2 review PR #618",
    createdAt: "2026-07-24T08:07:37.000Z",
    clientMessageId: `spawn_${launchId}`,
    payloadKind: "text",
    runtimeImages: [],
    contentDigest: null,
    artifactPaths: [],
    command: { operationId: `spawn_message_${launchId}`, kind: "send", policy: "queue" },
    requestDigest: null,
    state: "held",
    generationId: null,
    attempts: 0,
    assignedAt: null,
    deliveredAt: null,
    error: null,
  } satisfies HeldDelivery;
  fs.writeFileSync(filename, JSON.stringify(snapshot));

  return {
    registry: new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" }),
    launchId,
    conversationId,
    deliveryId,
    dir,
  };
}

test("issue 653: a held delivery of a failed spawn terminalizes to failed and stops being owed", () => {
  const fixture = makeFailedSpawnWithHeldDelivery();
  try {
    const before = fixture.registry.snapshot();
    /* Today's rot: the reservation is stuck `held` even though the spawn failed. */
    expect(before.heldDeliveries[fixture.deliveryId]?.state).toBe("held");
    expect(before.receipts[fixture.launchId]?.state).toBe("failed");

    /* The conversation is still "live"/owed only because of this stuck delivery. */
    const conversation = before.conversations[fixture.conversationId]!;
    const probe = livenessProbe({ now: () => Date.parse("2026-07-24T11:58:00.000Z") });
    expect(conversationIsLive(before, conversation, new Set(), probe)).toBe(true);

    const failed = fixture.registry.terminalizeFailedSpawnDeliveries();
    expect(failed).toContain(fixture.deliveryId);

    const after = fixture.registry.snapshot();
    expect(after.heldDeliveries[fixture.deliveryId]?.state).toBe("failed");
    /* No longer owed: a failed reservation is not an undelivered one. */
    expect(conversationIsLive(after, after.conversations[fixture.conversationId]!, new Set(), probe)).toBe(false);

    /* Idempotent: a second sweep is a no-op and never churns a terminal row. */
    expect(fixture.registry.terminalizeFailedSpawnDeliveries()).toEqual([]);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("issue 653: failStructuredSpawn terminalizes the initial held delivery in the same transaction", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-failed-spawn-inline-"));
  try {
    const filename = path.join(dir, "agent-registry.json");
    const cwd = path.join(dir, "pipeline");
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const begun = registry.beginSpawnRequest({
      engine: "claude", cwd, transport: "structured", accountId: "acctA",
      launchProfile: emptyLaunchProfile({ cwd, title: "Review the requested change" }),
    });
    if (begun.kind !== "created") throw new Error("expected structured launch creation");
    const { launchId, conversationId } = begun.receipt;

    // Seed a held initial delivery, then fail the spawn.
    const deliveryId = "held-inline";
    const snapshot = registry.snapshot();
    snapshot.heldDeliveries[deliveryId] = {
      id: deliveryId, conversationId, runtimeConversationId: conversationId,
      text: "prompt", createdAt: "2026-07-24T08:07:37.000Z",
      clientMessageId: `spawn_${launchId}`, payloadKind: "text", runtimeImages: [],
      contentDigest: null, artifactPaths: [],
      command: { operationId: `spawn_message_${launchId}`, kind: "send", policy: "queue" },
      requestDigest: null, state: "held", generationId: null, attempts: 0,
      assignedAt: null, deliveredAt: null, error: null,
    } satisfies HeldDelivery;
    fs.writeFileSync(filename, JSON.stringify(snapshot));

    const reloaded = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    reloaded.failStructuredSpawn(launchId, "spawn failed after held delivery");
    expect(reloaded.snapshot().heldDeliveries[deliveryId]?.state).toBe("failed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("issue 922: a never-started spawn whose migration-cancelled delivery is already failed terminalizes its receipt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-never-started-spawn-delivery-"));
  try {
    const filename = path.join(dir, "agent-registry.json");
    const cwd = path.join(dir, "pipeline");
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const begun = registry.beginSpawnRequest({
      engine: "codex", cwd, transport: "structured", accountId: "account-a",
      launchProfile: emptyLaunchProfile({ cwd, title: "Review the requested change" }),
      launchDisplay: { prompt: "synthetic kickoff", images: 0, echo: "synthetic kickoff" },
    });
    if (begun.kind !== "created") throw new Error("expected structured launch creation");
    const { launchId, conversationId } = begun.receipt;
    const deliveryId = "held-never-started";
    const snapshot = registry.snapshot();
    expect(snapshot.conversations[conversationId]).toBeUndefined();
    snapshot.heldDeliveries[deliveryId] = {
      id: deliveryId, conversationId, runtimeConversationId: conversationId,
      text: "synthetic kickoff", createdAt: "2026-08-05T10:00:00.000Z",
      clientMessageId: `spawn_${launchId}`, payloadKind: "text", runtimeImages: [],
      contentDigest: null, artifactPaths: [],
      command: { operationId: `spawn_message_${launchId}`, kind: "send", policy: "queue" },
      requestDigest: null, state: "failed", generationId: null, attempts: 0,
      assignedAt: null, deliveredAt: null,
      error: "delivery cancelled because its owning account migration made no progress; send again",
    } satisfies HeldDelivery;
    fs.writeFileSync(filename, JSON.stringify(snapshot));

    const reloaded = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    expect(reloaded.snapshot().receipts[launchId]?.state).not.toBe("failed");
    expect(reloaded.terminalizeFailedSpawnDeliveries()).toEqual([deliveryId]);
    expect(reloaded.snapshot().receipts[launchId]).toMatchObject({
      state: "failed",
      admissionOwner: null,
      error: expect.stringContaining("migration made no progress"),
    });
    expect(reloaded.snapshot().heldDeliveries[deliveryId]).toMatchObject({ state: "failed", attempts: 0 });
    expect(reloaded.terminalizeFailedSpawnDeliveries()).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("issue 922: a promote-race spawn failure terminalizes an assigned attempts-zero initial delivery inline", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-promote-race-spawn-delivery-"));
  try {
    const filename = path.join(dir, "agent-registry.json");
    const cwd = path.join(dir, "pipeline");
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "dual-write" });
    const conversation = registry.ensureConversation("codex", path.join(cwd, "session.jsonl"), "account-a");
    const begun = registry.beginSpawnRequest({
      engine: "codex", cwd, transport: "structured", accountId: "account-a",
      conversationId: conversation.id,
      launchProfile: emptyLaunchProfile({ cwd, title: "Review the requested change" }),
    });
    if (begun.kind !== "created") throw new Error("expected structured launch creation");
    const delivery = registry.holdDelivery(
      conversation.id,
      "synthetic kickoff",
      `spawn_${begun.receipt.launchId}`,
      "text",
      [],
      null,
      { operationId: `spawn_message_${begun.receipt.launchId}`, kind: "send", policy: "queue" },
    );
    expect(delivery).toMatchObject({ state: "assigned", attempts: 0 });

    registry.failSpawn(begun.receipt.launchId, "runtime host request timed out during release promotion");
    expect(registry.snapshot().receipts[begun.receipt.launchId]?.state).toBe("failed");
    expect(registry.snapshot().heldDeliveries[delivery.id]).toMatchObject({
      state: "failed",
      attempts: 0,
      generationId: null,
      assignedAt: null,
    });
    const sqlite = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" }).snapshot();
    expect(sqlite.receipts[begun.receipt.launchId]).toEqual(registry.snapshot().receipts[begun.receipt.launchId]);
    expect(sqlite.heldDeliveries[delivery.id]).toEqual(registry.snapshot().heldDeliveries[delivery.id]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("issue 922: a promote-race failure preserves an attempted delivery whose outcome is uncertain", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-promote-race-uncertain-delivery-"));
  try {
    const filename = path.join(dir, "agent-registry.json");
    const cwd = path.join(dir, "pipeline");
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const conversation = registry.ensureConversation("codex", path.join(cwd, "session.jsonl"), "account-a");
    const begun = registry.beginSpawnRequest({
      engine: "codex", cwd, transport: "structured", accountId: "account-a",
      conversationId: conversation.id,
      launchProfile: emptyLaunchProfile({ cwd, title: "Review the requested change" }),
    });
    if (begun.kind !== "created") throw new Error("expected structured launch creation");
    const delivery = registry.holdDelivery(
      conversation.id,
      "synthetic kickoff",
      `spawn_${begun.receipt.launchId}`,
      "text",
      [],
      null,
      { operationId: `spawn_message_${begun.receipt.launchId}`, kind: "send", policy: "queue" },
    );
    expect(registry.beginDeliveryAttempt(delivery.id, delivery.generationId!)).toMatchObject({
      state: "delivery-uncertain",
      attempts: 1,
    });

    registry.failSpawn(begun.receipt.launchId, "runtime host request timed out during release promotion");
    expect(registry.snapshot().heldDeliveries[delivery.id]).toMatchObject({
      state: "delivery-uncertain",
      attempts: 1,
    });
    expect(registry.terminalizeFailedSpawnDeliveries()).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("issue 653: the reaper cycle durably terminalizes a failed spawn's stuck initial held delivery", async () => {
  const fixture = makeFailedSpawnWithHeldDelivery();
  try {
    process.env.LLV_STATE_DIR = fixture.dir;
    expect(fixture.registry.snapshot().heldDeliveries[fixture.deliveryId]?.state).toBe("held");
    await runReaperCycle({ registry: fixture.registry, hosts: [], files: [], now: Date.parse("2026-07-24T11:58:00.000Z") });
    expect(fixture.registry.snapshot().heldDeliveries[fixture.deliveryId]?.state).toBe("failed");
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("issue 653: the failed spawn launch never projects a delivering initial message", () => {
  const fixture = makeFailedSpawnWithHeldDelivery();
  try {
    fixture.registry.terminalizeFailedSpawnDeliveries();
    const proj = projectLaunchConversations([], fixture.registry.snapshot(), Date.parse("2026-07-24T08:08:00.000Z"), () => false);
    const card = proj.cards.find((entry) => entry.conversationId === fixture.conversationId);
    expect(card?.spawn?.state).toBe("failed");
    expect(card?.spawn?.initialMessage).not.toBe("queued");
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

/* docs/design/delivery-progress-and-drain.md, C5. */
test("an inline launch failure waits for the lock off the loop and ends its first message once; refused, the launch and message stay for the convergence", async () => {
  const { sqliteRegistryFixture, registryLockHolder, longestLoopGap } = await import("./registryLockHolderFixture");
  const { blockingWaitDiagnostics, resetBlockingWaitsForTests } = await import("@/lib/blockingWaits");
  const made = sqliteRegistryFixture("llv-inline-launch-failure", { sqliteWriterDeadlineMs: 150 });
  const holder = registryLockHolder(made.sqliteFilename);
  const registry = made.registry;
  try {
    const launch = (name: string) => {
      const conversation = registry.ensureConversation("codex", path.join(made.root, `${name}.jsonl`), "account-a");
      const begun = registry.beginSpawnRequest({
        engine: "codex", cwd: made.root, transport: "structured", accountId: "account-a", conversationId: conversation.id,
        launchProfile: emptyLaunchProfile({ cwd: made.root, title: `Launch ${name}` }),
      });
      if (begun.kind !== "created") throw new Error("expected structured launch creation");
      const delivery = registry.holdDelivery(conversation.id, "first message", `spawn_${begun.receipt.launchId}`, "text", [], null,
        { operationId: `spawn_message_${begun.receipt.launchId}`, kind: "send", policy: "queue" });
      return { launchId: begun.receipt.launchId, delivery };
    };
    const waited = launch("waited");
    resetBlockingWaitsForTests(() => {});
    await holder.hold(120);
    const { value: failed, gapMs } = await longestLoopGap(() => registry.failSpawnOffLoop(waited.launchId, "launch failed"));
    expect(failed).toBe(true);
    expect(gapMs).toBeLessThan(50);
    expect(blockingWaitDiagnostics().longest.find((sample) => sample.label === "spawn.fail")).toMatchObject({
      operationId: `spawn_message_${waited.launchId}`, synchronous: false,
    });
    expect(registry.snapshot().heldDeliveries[waited.delivery.id]).toMatchObject({ state: "failed", attempts: 0 });

    const refused = launch("refused");
    await holder.hold(600);
    expect(await registry.failSpawnOffLoop(refused.launchId, "launch failed")).toBe(false);
    expect(registry.snapshot().receipts[refused.launchId]?.state).not.toBe("failed");
    expect(registry.snapshot().heldDeliveries[refused.delivery.id]).toMatchObject({ state: "assigned", attempts: 0 });
    await Bun.sleep(650);
    /* The convergence ends the launch and its first message in one transaction. */
    expect(registry.failSpawn(refused.launchId, "stale launch past its setup bound")).toBe(true);
    expect(registry.snapshot().heldDeliveries[refused.delivery.id]).toMatchObject({ state: "failed", attempts: 0 });
  } finally {
    await holder.close();
    registry.close();
    made.cleanup();
  }
});

test("a launch failure ends only its own first message; another launch's failed-spawn row stays for the convergence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-narrow-launch-failure-"));
  try {
    const registry = new AgentRegistry(path.join(dir, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
    const begin = (name: string) => {
      const conversation = registry.ensureConversation("codex", path.join(dir, `${name}.jsonl`), "account-a");
      const begun = registry.beginSpawnRequest({
        engine: "codex", cwd: dir, transport: "structured", accountId: "account-a", conversationId: conversation.id,
        launchProfile: emptyLaunchProfile({ cwd: dir, title: `Launch ${name}` }),
      });
      if (begun.kind !== "created") throw new Error("expected structured launch creation");
      const delivery = registry.holdDelivery(conversation.id, "first message", `spawn_${begun.receipt.launchId}`, "text", [], null,
        { operationId: `spawn_message_${begun.receipt.launchId}`, kind: "send", policy: "queue" });
      return { launchId: begun.receipt.launchId, delivery };
    };
    const other = begin("other");
    /* The other launch failed through a path that left its row (an older build). */
    const file = registry.snapshot();
    file.receipts[other.launchId] = { ...file.receipts[other.launchId]!, state: "failed", error: "older failure" };
    registry.restoreSnapshot(registry.snapshot(), file);
    const own = begin("own");
    registry.failSpawn(own.launchId, "own failure");
    expect(registry.snapshot().heldDeliveries[own.delivery.id]).toMatchObject({ state: "failed" });
    expect(registry.snapshot().heldDeliveries[other.delivery.id]).toMatchObject({ state: "assigned" });
    expect(registry.terminalizeFailedSpawnDeliveries()).toEqual([other.delivery.id]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
