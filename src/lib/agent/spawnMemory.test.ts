import { expect, spyOn, test } from "bun:test";
import { procBackend } from "@/lib/proc";
import { planAgentMemory, invalidateAgentScopeProbe } from "@/lib/runtime/agentMemory";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { agentRegistry } from "./registry";
import { spawnResponseForReceipt } from "./spawnResponse";
import { spawnAgentWithPrompt } from "@/lib/tmux";
import { assertSpawnMemoryAvailable } from "./spawnMemory";
import { parseMeminfo } from "@/lib/proc/memory";

const GIB = 1024 ** 3;

test.each(["auto", "scope", "watchdog", "off"])("the %s memory-limit mode cannot bypass launch admission", (mode) => {
  const memory = spyOn(procBackend, "systemMemory").mockReturnValue({
    ramTotal: 31 * GIB, ramAvailable: GIB, swapTotal: 24 * GIB, swapUsed: 19.5 * GIB,
  });
  invalidateAgentScopeProbe();
  try {
    expect(() => planAgentMemory({ engine: "headless", sessionKey: "fixture", liveAgents: 30 },
      { NODE_ENV: "test", DELEGATUS_AGENT_MEMORY: mode }, { totalBytes: 31 * GIB, probe: () => null, runner: () => "" }))
      .toThrow("1024 MiB RAM available; at least 2048 MiB required");
  } finally { memory.mockRestore(); invalidateAgentScopeProbe(); }
});

test("a legacy launch refuses low memory before preparing a pane and retains its reason", async () => {
  const previousTransport = process.env.LLV_SPAWN_TRANSPORT;
  process.env.LLV_SPAWN_TRANSPORT = "structured";
  const memory = spyOn(procBackend, "systemMemory").mockReturnValue({
    ramTotal: 31 * GIB, ramAvailable: GIB, swapTotal: 0, swapUsed: 0,
  });
  const registry = agentRegistry();
  const cwd = process.env.LLV_STATE_DIR!;
  const launchProfile = emptyLaunchProfile({ cwd, title: "Check legacy launch memory" });
  const begun = registry.beginSpawnRequest({ engine: "claude", cwd, transport: "tmux", launchProfile });
  if (begun.kind !== "created") throw new Error("fixture receipt missing");
  try {
    // The existing structured-transport refusal keeps the red run from
    // actuating tmux; memory refusal must precede it on the fixed path.
    await expect(spawnAgentWithPrompt({ command: "claude", engine: "claude", cwd, windowName: "memory", launchProfile }, "inspect", begun.receipt))
      .rejects.toThrow("1024 MiB RAM available; at least 2048 MiB required");
    const receipt = registry.readOnlySnapshot().receipts[begun.receipt.launchId]!;
    expect(receipt.pane).toBeNull();
    expect(spawnResponseForReceipt(receipt)).toMatchObject({
      state: "failed", launched: false, path: null,
      error: expect.stringContaining("1024 MiB RAM available"),
    });
  } finally {
    memory.mockRestore();
    if (previousTransport === undefined) delete process.env.LLV_SPAWN_TRANSPORT;
    else process.env.LLV_SPAWN_TRANSPORT = previousTransport;
  }
});

test("reclaimable caches, full swap and thirty lanes cannot reject a healthy machine", () => {
  const memory = spyOn(procBackend, "systemMemory").mockReturnValue(parseMeminfo(
    `MemTotal: ${135 * GIB / 1024} kB\nMemFree: 32768 kB\nMemAvailable: ${117 * GIB / 1024} kB\nSwapTotal: 25165824 kB\nSwapFree: 0 kB\n`,
  ));
  try {
    expect(() => assertSpawnMemoryAvailable()).not.toThrow();
    expect(() => planAgentMemory({ engine: "codex", sessionKey: "healthy", liveAgents: 30 },
      { NODE_ENV: "test", DELEGATUS_AGENT_MEMORY: "watchdog" }, { totalBytes: 135 * GIB, probe: () => null, runner: () => "" })).not.toThrow();
  } finally { memory.mockRestore(); invalidateAgentScopeProbe(); }
});

test.each([2 * GIB, null, Number.NaN, -1])("launch admission permits the floor or an unavailable reading (%s)", (available) => {
  const memory = spyOn(procBackend, "systemMemory").mockReturnValue(available === null
    ? null : { ramTotal: 16 * GIB, ramAvailable: available, swapTotal: 0, swapUsed: 0 });
  try { expect(() => assertSpawnMemoryAvailable()).not.toThrow(); }
  finally { memory.mockRestore(); }
});

test.each([0, 2 * GIB - 1])("launch admission refuses RAM below the floor (%s)", (available) => {
  const memory = spyOn(procBackend, "systemMemory").mockReturnValue({
    ramTotal: 16 * GIB, ramAvailable: available, swapTotal: 24 * GIB, swapUsed: 0,
  });
  try { expect(() => assertSpawnMemoryAvailable()).toThrow("at least 2048 MiB required"); }
  finally { memory.mockRestore(); }
});
