import fs from "node:fs";
import { expect, spyOn } from "bun:test";
import { statePath } from "@/lib/configDir";
import { AgentRegistry } from "@/lib/agent/registry";
import { withAccountMutationLockAsync } from "./accountMutation";

export function trackAccountLeases() {
  const lock = statePath("account-selection.lock");
  const open = fs.openSync, remove = fs.rmSync;
  let acquired: number | null = null;
  const holds: number[] = [];
  const opens = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    if (args[0] === lock && args[1] === "wx") acquired = performance.now();
    return fd;
  }) as typeof fs.openSync);
  const removes = spyOn(fs, "rmSync").mockImplementation(((...args: Parameters<typeof fs.rmSync>) => {
    if (args[0] === lock && acquired !== null) { holds.push(performance.now() - acquired); acquired = null; }
    return remove(...args);
  }) as typeof fs.rmSync);
  return {
    holds,
    stop() { opens.mockRestore(); removes.mockRestore(); },
  };
}

export async function measureContention(name: string, operation: (pause: () => Promise<void>) => Promise<unknown>) {
  const registry = new AgentRegistry(statePath(`${name}-registry.json`));
  const conversation = registry.ensureConversation("codex", `/fixture/${name}.jsonl`, "default");
  const leases = trackAccountLeases();
  const { holds } = leases;
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const work = operation(async () => { entered(); await held; });
  let pulses = 0;
  const timer = setInterval(() => { pulses++; }, 5);
  try {
    await Promise.race([ready, work.then(() => { throw new Error("slow dependency was not reached"); })]);
    const results = await Promise.allSettled([
      registry.beginSpawnRequestAsync({ engine: "codex", cwd: "/fixture", transport: "structured", accountId: "default", conversationId: conversation.id, purpose: "resume-successor", origin: { kind: "successor" }, launchProfile: { title: "Contention resume" } }),
      withAccountMutationLockAsync(() => registry.holdDelivery(conversation.id, "hello", `${name}-send`), { caller: "send" }),
      registry.beginSpawnRequestAsync({ engine: "codex", cwd: "/fixture", transport: "structured", accountId: "default", launchProfile: { title: "Contention spawn" } }),
    ]);
    await Bun.sleep(25);
    expect(pulses).toBeGreaterThan(0);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    expect(results[0]).toMatchObject({ status: "fulfilled", value: { kind: "created" } });
    expect(results[1]).toMatchObject({ status: "fulfilled", value: { id: expect.any(String) } });
    expect(results[2]).toMatchObject({ status: "fulfilled", value: { kind: "created" } });
  } finally {
    release();
    try { await work; }
    finally {
      clearInterval(timer);
      leases.stop();
      console.info(JSON.stringify({ measurement: name, maxHoldMs: Math.max(0, ...holds), holds: holds.length }));
    }
  }
  expect(Math.max(...holds)).toBeLessThan(250);
}
