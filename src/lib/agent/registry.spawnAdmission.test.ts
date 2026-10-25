import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry } from "./registry";
import { blockingWaitDiagnostics, resetBlockingWaitsForTests } from "@/lib/blockingWaits";
import { productionLaunchMembershipPorts } from "@/lib/tasks/launchMembership";

const input = { engine: "codex" as const, cwd: "/fixture", transport: "structured" as const,
  clientAttemptId: "contended-membership", launchProfile: { title: "Writer admission" } };

function fixture(waitMs?: number, sqliteMode: "sqlite" | "off" = "sqlite") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-admission-"));
  const filename = path.join(directory, "registry.json");
  const registry = new AgentRegistry(filename, undefined, undefined,
    { sqliteMode, ...(waitMs === undefined ? {} : { sqliteWriterDeadlineMs: waitMs }) });
  return { registry, filename, cleanup() { registry.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test("spawn membership record waits through a writer held longer than the old two-second budget", async () => {
  const f = fixture();
  const peer = new Database(f.filename.replace(/\.json$/, ".sqlite"));
  let held = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const commit = spyOn(productionLaunchMembershipPorts, "commit").mockImplementation(() => {
    peer.exec("BEGIN IMMEDIATE"); held = true;
    timer = setTimeout(() => { peer.exec("ROLLBACK"); held = false; }, 2_100);
    return { ok: true, tasks: [], taskIds: ["fixture-task"], created: [], changed: false };
  });
  try {
    const result = await f.registry.beginSpawnRequestAsync(input);
    expect(result.kind).toBe("created");
    expect(f.registry.spawnReceipt(result.receipt.launchId)?.membershipAdmitted).toBe(true);
    // The dispatch boundary may take the writer: admission has released it.
    peer.exec("BEGIN IMMEDIATE"); peer.exec("ROLLBACK");
  } finally {
    clearTimeout(timer); if (held) peer.exec("ROLLBACK"); peer.close(); commit.mockRestore(); f.cleanup();
  }
}, 10_000);

async function holder(filename: string, sqliteMode: "sqlite" | "off" | "state" | "startup" = "sqlite") {
  const child = Bun.spawn([process.execPath, "-e", `
    const hold = () => {
      process.stdout.write("held\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
    };
    if (process.argv[2] === "state") {
      const { initializeStateCollections, SqliteStateCollection } = await import("./src/lib/state/sqliteStateStore.ts");
      const { withWaitCorrelation } = await import("./src/lib/blockingWaits.ts");
      const filename = process.argv[1].replace(/\\.json$/, ".sqlite");
      initializeStateCollections(filename, [{ collection: "writer-fixture", schemaVersion: 1,
        migrationId: "writer-fixture", key: row => row.id, loadRecords: () => [] }]);
      const collection = new SqliteStateCollection(filename, { collection: "writer-fixture", schemaVersion: 1,
        busyMessage: "writer fixture busy", key: row => row.id, decode: row => row, clone: row => ({ ...row }) });
      withWaitCorrelation({ label: "state.staged-recovery" }, () => collection.boundedPatch(1, hold));
    } else if (process.argv[2] === "startup") {
      const { Database } = await import("bun:sqlite");
      const { withWaitCorrelation } = await import("./src/lib/blockingWaits.ts");
      const exec = Database.prototype.exec;
      const transaction = Database.prototype.transaction;
      let immediate = false;
      Database.prototype.exec = function(sql, ...args) {
        if (immediate && !/^\\s*(?:COMMIT|ROLLBACK)\\b/i.test(sql)) hold();
        const result = exec.call(this, sql, ...args);
        if (/^\\s*BEGIN\\s+IMMEDIATE\\b/i.test(sql)) immediate = true;
        return result;
      };
      Database.prototype.transaction = function(write, self) {
        return transaction.call(this, (...args) => { hold(); return write(...args); }, self);
      };
      const { AgentRegistry } = await import("./src/lib/agent/registry.ts");
      withWaitCorrelation({ label: "registry.staged-recovery" }, () =>
        new AgentRegistry(process.argv[1], undefined, undefined, { sqliteMode: "sqlite" }));
      throw new Error("startup transaction was not observed");
    } else {
      const { AgentRegistry } = await import("./src/lib/agent/registry.ts");
      const registry = new AgentRegistry(process.argv[1], undefined, undefined, { sqliteMode: process.argv[2] });
      registry.deliveryWriteNow({ label: "registry.staged-recovery" }, hold);
    }
  `, filename, sqliteMode], { stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  try {
    const result = await reader.read();
    expect(new TextDecoder().decode(result.value)).toContain("held");
    return child;
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    throw error;
  } finally { reader.releaseLock(); }
}

test.each(["sqlite", "off", "state", "startup"] as const)("spawn admission names a live writer at its deadline (%s)", async sqliteMode => {
  const f = fixture(150, sqliteMode === "off" ? "off" : "sqlite");
  let child: Awaited<ReturnType<typeof holder>> | undefined;
  try {
    child = await holder(f.filename, sqliteMode);
    await expect(f.registry.beginSpawnRequestAsync(input)).rejects.toThrow(
      new RegExp(`${sqliteMode === "state" ? "state" : "registry"}\\.staged-recovery.*pid=${child.pid}.*age=\\d+ms`));
    expect(Object.keys(f.registry.readOnlySnapshot().receipts)).toHaveLength(0);
  } finally {
    if (child?.exitCode === null) child.kill("SIGKILL");
    await child?.exited;
    f.cleanup();
  }
});

test.each((["sqlite", "off", "state", "startup"] as const).flatMap(sqliteMode => [false, true].map(revoked => ({ sqliteMode, revoked }))))(
  "a writer dying during admission releases the wait: %j", async ({ sqliteMode, revoked }) => {
  const f = fixture(2_000, sqliteMode === "off" ? "off" : "sqlite");
  let child: Awaited<ReturnType<typeof holder>> | undefined;
  let current = true;
  let refused = false;
  let end: Promise<unknown> | undefined;
  const write = f.registry.deliveryWriteNow.bind(f.registry);
  const probe = spyOn(f.registry, "deliveryWriteNow").mockImplementation(<T>(
    correlation: Parameters<AgentRegistry["deliveryWriteNow"]>[0],
    operation: () => T,
    options?: Parameters<AgentRegistry["deliveryWriteNow"]>[2],
  ) => {
    const result = write(correlation, operation, options);
    if (!result.acquired && !refused) {
      refused = true;
      // Change custody only after observing the actual failed writer probe.
      end = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
        if (revoked) current = false;
        child!.kill("SIGKILL");
        await child!.exited;
      });
    }
    return result;
  });
  resetBlockingWaitsForTests(() => {});
  try {
    child = await holder(f.filename, sqliteMode);
    const work = f.registry.beginSpawnRequestAsync(input, () => {
      if (!current) throw new Error("spawn admission superseded");
    });
    if (revoked) {
      await expect(work).rejects.toThrow("spawn admission superseded");
      expect(Object.keys(f.registry.readOnlySnapshot().receipts)).toHaveLength(0);
    } else {
      const result = await work;
      expect(result.kind).toBe("created");
      expect(f.registry.spawnReceipt(result.receipt.launchId)?.membershipAdmitted).toBe(true);
      expect(blockingWaitDiagnostics().sites["registry-lock-async"]).toBeDefined();
    }
    expect(refused).toBe(true);
  } finally {
    await end;
    if (child?.exitCode === null) child.kill("SIGKILL");
    await child?.exited;
    probe.mockRestore();
    f.cleanup();
  }
});
