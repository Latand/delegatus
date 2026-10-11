import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, spyOn, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { spawnResponseForReceipt } from "@/lib/agent/spawnResponse";
import { procBackend } from "@/lib/proc";
import type { RuntimeHostClient } from "./client";
import { spawnStructuredConversation } from "./structuredSpawn";

const GIB = 1024 ** 3;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-memory-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function fixture(engine: "claude" | "codex" | "copilot" = "codex") {
  const cwd = fs.mkdtempSync(path.join(sandbox, "launch-"));
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const launchProfile = emptyLaunchProfile({ cwd, title: "Check launch memory admission" });
  const begun = registry.beginSpawnRequest({ engine, cwd, transport: "structured", launchProfile });
  if (begun.kind !== "created") throw new Error("fixture receipt missing");
  let admissions = 0;
  const client = {
    command: async () => { admissions++; throw new Error("runtime admission reached"); },
    transitionOperation: async () => {},
  } as unknown as RuntimeHostClient;
  return {
    registry, receipt: begun.receipt, admissions: () => admissions,
    input: {
      engine, registry, receipt: begun.receipt,
      spec: { command: engine, engine, cwd, windowName: "memory", launchProfile },
      account: { engine, accountId: "account-a", kind: "managed" as const, home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" as const } },
      "prompt": "Check memory admission", client,
    },
  };
}

test.each(["claude", "codex", "copilot"] as const)("a memory-starved %s launch fails before runtime admission and persists its measured reason", async (engine) => {
  const memory = spyOn(procBackend, "systemMemory").mockReturnValue({
    ramTotal: 31 * GIB, ramAvailable: GIB, swapTotal: 24 * GIB, swapUsed: 19.5 * GIB,
  });
  const launch = fixture(engine);
  try {
    await expect(spawnStructuredConversation(launch.input)).rejects.toThrow(
      "Agent launch refused: 1024 MiB RAM available; at least 2048 MiB required. Retry after memory is freed.",
    );
    expect(launch.admissions()).toBe(0);
    const reopened = new AgentRegistry(launch.registry.filename, undefined, undefined, { sqliteMode: "off" });
    const receipt = reopened.readOnlySnapshot().receipts[launch.receipt.launchId]!;
    expect(receipt).toMatchObject({ state: "failed", admissionOwner: null, artifactPath: null });
    expect(spawnResponseForReceipt(receipt)).toMatchObject({
      state: "failed", launched: false, initialMessage: "failed", path: null,
      error: expect.stringContaining("1024 MiB RAM available; at least 2048 MiB required"),
    });
    expect(Object.keys(reopened.readOnlySnapshot().entries)).toHaveLength(0);
  } finally { memory.mockRestore(); }
});

test.each([2 * GIB, 117 * GIB, null])("structured admission proceeds at healthy or unavailable RAM (%s)", async (available) => {
  const memory = spyOn(procBackend, "systemMemory").mockReturnValue(available === null
    ? null : { ramTotal: 135 * GIB, ramAvailable: available, swapTotal: 24 * GIB, swapUsed: 24 * GIB });
  const launch = fixture();
  try {
    await expect(spawnStructuredConversation(launch.input)).rejects.toThrow("runtime admission reached");
    expect(launch.admissions()).toBe(1);
  } finally { memory.mockRestore(); }
});
