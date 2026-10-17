import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, setSystemTime, test } from "bun:test";

import { AgentRegistry } from "./registry";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

test("global delivery compaction scopes owner reads, skips unchanged passes, and wakes for expiry", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "registry-delivery-compaction-"));
  let clock = Date.parse("2026-10-16T08:00:00.000Z");
  setSystemTime(clock);
  const reads = new Map<string, number>();
  let registry: AgentRegistry | null = null;
  const resetReads = () => reads.clear();
  const count = (collection: string) => reads.get(collection) ?? 0;
  try {
    registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, {
      sqliteMode: "sqlite",
      now: () => clock,
      onSqliteRowPayloadRead: (collection, count) => reads.set(collection, (reads.get(collection) ?? 0) + count),
    });
    for (let index = 0; index < 20; index += 1) {
      const conversation = registry.ensureConversation("codex", `/compaction/${index}.jsonl`, null);
      const operationId = `seeded-operation-${String(index).padStart(2, "0")}`;
      const delivery = registry.holdDelivery(conversation.id, `payload ${index}`, `message-${index}`, "text", [], null, { operationId });
      registry.recordDeliveryOutcome(delivery.id, "failed", "unverified", "unverified");
    }

    registry.compactDeliveryReservations();
    resetReads();
    expect(registry.compactDeliveryReservations()).toBe(0);
    expect(count("deliveryOperationOwners")).toBe(0);
    expect(count("heldDeliveries")).toBe(0);

    registry.ensureConversation("codex", "/compaction/unrelated.jsonl", null);
    resetReads();
    expect(registry.compactDeliveryReservations()).toBe(0);
    expect(count("deliveryOperationOwners")).toBe(0);
    expect(count("heldDeliveries")).toBe(0);

    const changedConversation = registry.ensureConversation("codex", "/compaction/new.jsonl", null);
    const changed = registry.holdDelivery(changedConversation.id, "new payload", "new-message", "text", [], null,
      { operationId: "new-operation" });
    registry.recordDeliveryOutcome(changed.id, "failed", "unverified", "unverified");
    resetReads();
    registry.compactDeliveryReservations();
    expect(count("deliveryOperationOwners")).toBe(1);
    expect(count("heldDeliveries")).toBe(1);

    resetReads();
    expect(registry.compactDeliveryReservations()).toBe(0);
    expect(count("deliveryOperationOwners")).toBe(0);
    expect(count("heldDeliveries")).toBe(0);

    const expiringConversation = registry.ensureConversation("codex", "/compaction/expiry.jsonl", null);
    const expiring = registry.holdDelivery(expiringConversation.id, "expire me", "expiry-message", "text", [], null,
      { operationId: "expiry-operation" });
    registry.recordDeliveryOutcome(expiring.id, "delivered");
    registry.compactDeliveryReservations();
    clock += RETENTION_MS + 1_000;
    expect(registry.compactDeliveryReservations()).toBeGreaterThan(0);
    expect(registry.snapshot().heldDeliveries[expiring.id]).toBeUndefined();
  } finally {
    try { registry?.close(); }
    finally {
      fs.rmSync(directory, { recursive: true, force: true });
      setSystemTime();
    }
  }
});

test("a fresh process rebuilds the delivery compaction cursor from the registry", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "registry-delivery-compaction-restart-"));
  const filename = path.join(directory, "registry.json");
  let registry: AgentRegistry | null = null;
  try {
    registry = new AgentRegistry(filename, undefined, undefined, {
      sqliteMode: "sqlite",
      now: () => Date.parse("2026-10-16T08:00:00.000Z"),
    });
    const conversation = registry.ensureConversation("codex", "/compaction/restart.jsonl", null);
    const delivery = registry.holdDelivery(conversation.id, "restart payload", "restart-message", "text", [], null,
      { operationId: "restart-operation" });
    registry.recordDeliveryOutcome(delivery.id, "delivered");
    registry.compactDeliveryReservations();
    registry.close();
    registry = null;

    const childRoot = path.join(directory, "child");
    const env = {
      ...process.env,
      HOME: path.join(childRoot, "home"),
      XDG_CONFIG_HOME: path.join(childRoot, "config"),
      LLV_STATE_DIR: path.join(childRoot, "state"),
      TMPDIR: path.join(childRoot, "tmp"),
    };
    for (const pathname of [env.HOME, env.XDG_CONFIG_HOME, env.LLV_STATE_DIR, env.TMPDIR]) {
      fs.mkdirSync(pathname!, { recursive: true });
    }
    const code = `
      import { AgentRegistry } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "registry.ts")).href)};
      let ownerReads = 0;
      const registry = new AgentRegistry(process.argv[1], undefined, undefined, {
        sqliteMode: "sqlite", now: () => Date.parse("2026-10-16T08:00:00.000Z"),
        onSqliteRowPayloadRead: (collection, count) => { if (collection === "deliveryOperationOwners") ownerReads += count; },
      });
      ownerReads = 0;
      registry.compactDeliveryReservations();
      console.log(JSON.stringify({ ownerReads }));
      registry.close();
    `;
    const child = Bun.spawn([process.execPath, "-e", code, filename], { stdout: "pipe", stderr: "pipe", env });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    expect(JSON.parse(stdout).ownerReads).toBeGreaterThan(0);
  } finally {
    try { registry?.close(); }
    finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
});
