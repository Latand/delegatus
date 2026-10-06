import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, spyOn, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import type { RuntimeHostClient } from "./client";
import { CodexAppServerHost, type CodexAppServerHostOptions } from "./codexAppServerHost";
import { GIB, setAgentMemoryPortsForTests } from "./agentMemory";
import { CpuContainmentUnavailable, setCpuPortsForTests } from "./cpuPlacement";
import { CpuPressureGate } from "./cpuPressure";
import { startupAdoptionCell } from "./fixtures/startupAdoptionCell";
import { adoptCodexRegistryHosts } from "./registry";
import { defaultStartHost } from "./structuredSpawn";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-cpu-"));
const previous = { cpu: process.env.LLV_AGENT_CPU, memory: process.env.LLV_AGENT_MEMORY };
afterAll(() => {
  setCpuPortsForTests(null);
  setAgentMemoryPortsForTests(null);
  for (const [key, value] of [["LLV_AGENT_CPU", previous.cpu], ["LLV_AGENT_MEMORY", previous.memory]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** Every structured engine host spawns through its memory cell's wrapper; this
    captures the cell the real launch path builds for a fresh Codex host. */
async function launchedPlacement(member: "pipeline" | "flow" | "orchestrator" | null) {
  const cwd = fs.mkdtempSync(path.join(sandbox, "host-"));
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const launchProfile = emptyLaunchProfile({ cwd });
  const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd, transport: "structured", launchProfile });
  if (begun.kind !== "created") throw new Error("fixture receipt missing");
  if (member) registry.rememberMembership(begun.receipt.conversationId, { kind: member, containerId: `${member}_1`, role: "builder", slot: "build",
    stageId: null, stageOrder: null, round: null, parentConversationId: null });
  const seen: CodexAppServerHostOptions[] = [];
  const start = spyOn(CodexAppServerHost, "start").mockImplementation(async (options) => { seen.push(options); throw new Error("captured host options"); });
  try {
    await expect(defaultStartHost({ engine: "codex", registry, receipt: begun.receipt, spec: { command: "codex", engine: "codex", cwd, windowName: "cpu", launchProfile },
      account: { engine: "codex", accountId: "account-a", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } }, prompt: "", client: {} as RuntimeHostClient }, "fixture-capability"))
      .rejects.toThrow("captured host options");
  } finally { start.mockRestore(); }
  return seen[0]!.memoryCell!.plan;
}

test("a pipeline or flow host launches into the work slice; an operator host keeps the agents slice", async () => {
  process.env.LLV_AGENT_CPU = "auto";
  process.env.LLV_AGENT_MEMORY = "off";
  const quotas: string[][] = [];
  setCpuPortsForTests({ probe: () => ({ kind: "available", systemdVersion: 255 }), cpus: 24, agentSlice: "test-agents.slice", workSlice: "test-agents-work.slice",
    runner: (command, args) => { quotas.push([command, ...args]); return ""; } });
  for (const member of ["pipeline", "flow"] as const) {
    const plan = await launchedPlacement(member);
    expect(plan.cpu).toMatchObject({ workload: "work", slice: "test-agents-work.slice", weight: 100, quotaPercent: 300 });
    expect(plan.mechanism).toBe("none");
  }
  for (const member of ["orchestrator", null] as const) {
    expect((await launchedPlacement(member)).cpu).toMatchObject({ workload: "operator", slice: "test-agents.slice", weight: 1000, quotaPercent: null });
  }
  expect(quotas).toEqual([["systemctl", "--user", "set-property", "--runtime", "test-agents-work.slice", "CPUWeight=100", "CPUQuota=1800%", "CPUQuotaPeriodSec=20ms"]]);
});

test("a pipeline host refuses to start when CPU containment is expected and missing", async () => {
  process.env.LLV_AGENT_CPU = "auto";
  process.env.LLV_AGENT_MEMORY = "off";
  setCpuPortsForTests({ probe: () => ({ kind: "missing", reason: "the systemd user manager does not delegate the cpu controller" }), runner: () => "" });
  const cwd = fs.mkdtempSync(path.join(sandbox, "refused-"));
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const launchProfile = emptyLaunchProfile({ cwd });
  const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd, transport: "structured", launchProfile });
  if (begun.kind !== "created") throw new Error("fixture receipt missing");
  registry.rememberMembership(begun.receipt.conversationId, { kind: "pipeline", containerId: "pipeline_1", role: "builder", slot: "build", stageId: null, stageOrder: null, round: null, parentConversationId: null });
  const start = spyOn(CodexAppServerHost, "start");
  try {
    await expect(defaultStartHost({ engine: "codex", registry, receipt: begun.receipt, spec: { command: "codex", engine: "codex", cwd, windowName: "cpu", launchProfile },
      account: { engine: "codex", accountId: "account-a", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } }, prompt: "", client: {} as RuntimeHostClient }, "fixture-capability"))
      .rejects.toThrow("CPU containment for agent work is unavailable: the systemd user manager does not delegate the cpu controller");
    expect(start).not.toHaveBeenCalled();
  } finally { start.mockRestore(); }
});

test("boot adoption gives every engine host the cell of its class, with memory off and on, and never asks CPU pressure", async () => {
  process.env.LLV_AGENT_CPU = "auto";
  const pressure = spyOn(CpuPressureGate.prototype, "check");
  setCpuPortsForTests({ probe: () => ({ kind: "available", systemdVersion: 255 }), cpus: 24, agentSlice: "test-agents.slice", workSlice: "test-agents-work.slice", runner: () => "" });
  setAgentMemoryPortsForTests({ totalBytes: 64 * GIB, probe: () => 255, runner: () => "" });
  try {
    for (const memory of ["off", "scope"] as const) {
      process.env.LLV_AGENT_MEMORY = memory;
      for (const engine of ["codex", "claude"] as const) {
        for (const member of ["pipeline", "flow", null] as const) {
          const adopted = await startupAdoptionCell(sandbox, engine, member);
          if (!("cell" in adopted)) throw adopted.refused;
          const plan = adopted.cell!.plan;
          expect(plan.mechanism).toBe(memory === "off" ? "none" : "scope");
          expect(plan.cpu).toMatchObject(member
            ? { workload: "work", slice: "test-agents-work.slice", weight: 100, quotaPercent: 300 }
            : { workload: "operator", slice: "test-agents.slice", weight: 1000, quotaPercent: null });
        }
      }
    }
    expect(pressure).not.toHaveBeenCalled();
  } finally { pressure.mockRestore(); setAgentMemoryPortsForTests(null); }
});

test("boot adoption refuses work it cannot contain and leaves the row dead with the reason", async () => {
  process.env.LLV_AGENT_CPU = "auto";
  process.env.LLV_AGENT_MEMORY = "off";
  const reason = "the kernel applied no CPU controls to a scope in test-agents.slice; the cpu controller is off on one of its ancestors";
  setCpuPortsForTests({ probe: () => ({ kind: "missing", reason }), runner: () => "" });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const engine of ["codex", "claude"] as const) {
      const refused = await startupAdoptionCell(sandbox, engine, "pipeline");
      expect("refused" in refused && refused.refused.message).toBe(`CPU containment for agent work is unavailable: ${reason}. Set DELEGATUS_AGENT_CPU=off to run work without CPU placement.`);
      // An operator host is never refused; it runs without placement.
      expect(await startupAdoptionCell(sandbox, engine, null)).toEqual({ cell: null });
    }
    // The real adopter: the refusal is logged, the row is left dead, and no host opens.
    const cwd = fs.mkdtempSync(path.join(sandbox, "adopter-"));
    const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    const key = { engine: "codex" as const, sessionId: "refused-work" };
    registry.upsert({ key, artifactPath: path.join(cwd, "refused.jsonl"), cwd, accountId: null, launchProfile: emptyLaunchProfile({ cwd }), status: "idle", host: null,
      structuredHost: { kind: "codex-app-server", endpoint: "stdio:retained", process: null, eventCursor: 0, protocolVersion: "test", writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
      claimEpoch: 0, claimOwner: null, pendingAction: null });
    const opened: string[] = [];
    const adopted = await adoptCodexRegistryHosts(registry, () => { throw new CpuContainmentUnavailable(reason); }, { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" }, () => true, undefined,
      { admit: () => null, adoptHost: async (sessionId) => { opened.push(sessionId); throw new Error("no host should open"); } });
    expect(adopted).toEqual([]);
    expect(opened).toEqual([]);
    expect(registry.readOnlySnapshot().entries["codex:refused-work"]?.status).toBe("dead");
    expect(logged.mock.calls.map((call) => String(call[0]))).toContain(`[structured hosts] boot adoption of codex:refused-work failed: CPU containment for agent work is unavailable: ${reason}. Set DELEGATUS_AGENT_CPU=off to run work without CPU placement.`);
  } finally { warn.mockRestore(); logged.mockRestore(); }
});
