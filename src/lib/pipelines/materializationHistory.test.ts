import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, spyOn, test } from "bun:test";

import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { buildRegistryPerformanceDataset, scaledRegistryPerformanceShape } from "@/lib/agent/registryPerformanceDataset";
import { defaultPipelinePorts } from "./engine";

test("pipeline identity reads stay bounded with cold and warm archived receipt history", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-materialization-history-"));
  let registry: AgentRegistry | undefined;
  try {
    const dataset = buildRegistryPerformanceDataset(directory, scaledRegistryPerformanceShape(0.05), {
      sessionsRoot: path.join(directory, "sessions"),
    });
    let payloads = 0;
    registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, {
      sqliteMode: "sqlite", sqliteFilename: dataset.filename,
      onSqliteRowPayloadRead: (_collection, count) => { payloads += count; },
    });
    setAgentRegistryForTests(registry);
    registry.readOnlySnapshot();
    const target = dataset.conversations.at(-1)!;
    const stat = spyOn(fs, "statSync");
    try {
      for (let pass = 0; pass < 2; pass++) {
        payloads = 0;
        stat.mockClear();
        const ports = defaultPipelinePorts();
        expect(ports.pathForConversation(target.conversationId)).toBe(target.path);
        expect(ports.pathForConversation(target.conversationId)).toBe(target.path);
        const identityReads = stat.mock.calls.filter(([filename]) => filename === dataset.filename).length;
        console.info("pipeline identity history", { pass, payloads, identityReads });
        expect(payloads).toBeLessThan(12);
        expect(identityReads).toBeLessThan(20);
      }
    } finally { stat.mockRestore(); }
  } finally {
    setAgentRegistryForTests(null);
    registry?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
