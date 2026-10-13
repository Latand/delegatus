import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { buildRegistryPerformanceDataset, scaledRegistryPerformanceShape } from "@/lib/agent/registryPerformanceDataset";
import { defaultPipelinePorts } from "./engine";

test("an unrelated pipeline adoption lookup leaves retained spawn receipts unread", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-adoption-history-"));
  buildRegistryPerformanceDataset(directory, scaledRegistryPerformanceShape(0.03));
  const reads = new Map<string, number>();
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, {
    sqliteMode: "sqlite",
    onSqliteRowPayloadRead: (collection, count) => reads.set(collection, (reads.get(collection) ?? 0) + count),
  });
  setAgentRegistryForTests(registry);
  try {
    registry.readOnlySnapshot();
    reads.clear();
    const ports = defaultPipelinePorts();
    expect(ports.pipelineAdoptionCandidates("unrelated-pipeline")).toEqual([]);
    expect(ports.pipelineAdoptionCandidates("unrelated-pipeline")).toEqual([]);
    expect(reads.get("receipts") ?? 0).toBe(0);
  } finally {
    setAgentRegistryForTests(null);
    registry.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
