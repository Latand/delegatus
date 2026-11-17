import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry } from "@/lib/agent/registry";
import { OperationLease, currentOperationLease } from "@/lib/operationLease";
import { setStructuredDeliveryKick } from "@/lib/runtime/structuredDeliverySignal";
import { reconcileAccountMigrationCycle } from "./controller";
import { noSuccessor } from "./peakLoad.fixture";

test("migration completes while an independently owned delivery wake remains held", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "migration-cycle-budget-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let wakeLease: unknown = "not called";
  setStructuredDeliveryKick(() => { wakeLease = currentOperationLease(); return held; });
  const lease = new OperationLease();
  const cycle = lease.run(() => reconcileAccountMigrationCycle(registry, { async tick() {} }, noSuccessor,
    { async deliver() { throw new Error("unexpected dispatch"); } }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([cycle.then(() => "completed"),
      new Promise(resolve => { timer = setTimeout(() => resolve("waiting for queue"), 100); })]);
    expect(result).toBe("completed");
    expect(wakeLease).toBeUndefined();
  } finally {
    if (timer) clearTimeout(timer);
    release(); await cycle;
    setStructuredDeliveryKick(null); registry.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});


test("an external watcher sees bounded cycles sharing held quota work and observing its late failure", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "migration-quota-deadline-"));
  const code = `
    import { AgentRegistry } from ${JSON.stringify(new URL("../../agent/registry.ts", import.meta.url).pathname)};
    import { reconcileAccountMigrationCycle } from ${JSON.stringify(new URL("./controller.ts", import.meta.url).pathname)};
    import { OperationLease, currentOperationLease } from ${JSON.stringify(new URL("../../operationLease.ts", import.meta.url).pathname)};
    const registry = new AgentRegistry(process.argv[1]);
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const calls = []; const settled = []; const leases = [];
    const quota = { async tick(engine) {
      calls.push(engine); leases.push(currentOperationLease() === undefined);
      await held; settled.push(engine);
      if (engine === "copilot") throw new Error("late-quota-refusal");
    } };
    const provider = { async create() { throw new Error("unexpected successor"); }, async verify() {} };
    const delivery = { async deliver() { throw new Error("unexpected dispatch"); } };
    const lease = new OperationLease();
    console.log("START");
    await lease.run(() => reconcileAccountMigrationCycle(registry, quota, provider, delivery));
    lease.expire(); console.log("FIRST");
    await reconcileAccountMigrationCycle(registry, quota, provider, delivery);
    console.log("SECOND " + JSON.stringify({ calls, leases }));
    for await (const chunk of Bun.stdin.stream()) { release(); break; }
    await new Promise(resolve => setImmediate(resolve));
    console.log("SETTLED " + JSON.stringify(settled)); registry.close();
  `;
  const child = Bun.spawn([process.execPath, "--eval", code, path.join(directory, "registry.json")],
    { env: process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let late = false;
  let released = false;
  let output = "";
  const arm = () => { clearTimeout(timeout); timeout = setTimeout(() => { late = true; child.kill(); }, 6_500); };
  const errors = new Response(child.stderr).text();
  try {
    const reader = (async () => {
      const stdout = child.stdout.getReader();
      try {
        for (;;) {
          const { value: chunk, done } = await stdout.read();
          if (done) break;
          output += new TextDecoder().decode(chunk);
          if (output.includes("START") && !timeout) arm();
          if (output.includes("FIRST") && !output.includes("SECOND")) arm();
          if (output.includes("SECOND") && !released) {
            released = true; clearTimeout(timeout); child.stdin.write("release\n"); child.stdin.end();
          }
        }
      } finally { stdout.releaseLock(); }
    })();
    await reader;
    expect(await child.exited).toBe(0);
    expect(late).toBe(false);
    const second = JSON.parse(output.split("SECOND ")[1]!.split("\n")[0]!);
    expect(second.calls).toEqual(["claude", "codex", "copilot"]);
    expect(second.leases).toEqual([true, true, true]);
    expect(JSON.parse(output.split("SETTLED ")[1]!)).toEqual(["claude", "codex", "copilot"]);
    expect((await errors).match(/quota tick failed/g)).toHaveLength(1);
    expect(await errors).toContain("late-quota-refusal");
  } finally {
    clearTimeout(timeout); child.stdin.end();
    if (child.exitCode === null) child.kill();
    await child.exited; fs.rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);


for (const phase of ["migration", "quota"] as const) {
  test(`a completed ${phase} failure stays visible while quota work remains held`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "migration-peer-failure-"));
    const registry = new AgentRegistry(path.join(directory, "registry.json"));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const failure = new Error(`${phase}-discovery-refused`);
    const discovery = phase === "migration"
      ? spyOn(registry, "migrationWorkPage").mockImplementation(() => { throw failure; }) : null;
    const cycle = reconcileAccountMigrationCycle(registry, { async tick(engine) {
      if (phase === "quota" && engine === "claude") throw failure;
      await held;
    } }, noSuccessor, { async deliver() { throw new Error("unexpected dispatch"); } }, 20);
    try { await expect(cycle).rejects.toBe(failure); }
    finally {
      release(); await cycle.catch(() => undefined);
      await new Promise<void>(resolve => setImmediate(resolve));
      discovery?.mockRestore(); registry.close(); fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
