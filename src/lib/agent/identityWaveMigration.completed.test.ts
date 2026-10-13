import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { AgentRegistry } from "./registry";
import { buildRegistryPerformanceDataset, scaledRegistryPerformanceShape } from "./registryPerformanceDataset";

for (const dryRun of [false, true]) {
  test(`completed identity migration leaves retained history unread and takes no write lease (dryRun=${dryRun})`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "identity-completed-history-"));
    const dataset = buildRegistryPerformanceDataset(directory, scaledRegistryPerformanceShape(0.03));
    const filename = path.join(directory, "agent-registry.json");
    const reads = new Map<string, number>();
    const registry = new AgentRegistry(filename, undefined, undefined, {
      sqliteMode: "sqlite",
      onSqliteRowPayloadRead: (collection, count) => reads.set(collection, (reads.get(collection) ?? 0) + count),
    });
    const writer = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
    try {
      expect(dataset.coldRows).toBeGreaterThan(500);
      registry.readOnlySnapshot();
      // An unrelated writer's revision must not make a completed migration
      // clone the archive or attempt another migration transaction.
      writer.ensureConversation("codex", "/sessions/external-new.jsonl", null);
      reads.clear();
      const result = registry.runIdentityWaveMigration({
        dryRun,
        now: new Date().toISOString(),
        orchestratorSeats: [],
        transcriptTitle: () => { throw new Error("completed migration read transcript evidence"); },
        sharedPathForLegacy: () => { throw new Error("completed migration read rekey evidence"); },
        commitExternalPathRekeys: () => { throw new Error("completed migration wrote external state"); },
      }, () => { throw new Error("completed migration entered a write transaction"); });
      expect(result).toEqual({ dryRun, alreadyCompleted: true, retitled: 0, rekeyed: 0, quarantinedRekeys: 0, edgesStamped: 0 });
      expect([...reads.values()].reduce((total, count) => total + count, 0)).toBeLessThan(50);
      expect(writer.conversationForPath("/sessions/external-new.jsonl")).not.toBeNull();
    } finally {
      registry.close();
      writer.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
