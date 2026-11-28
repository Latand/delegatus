import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry } from "@/lib/agent/registry";
import { withFileTransaction } from "@/lib/state/fileTransaction";
import { runStructuredHostStartup } from "@/lib/viewerInstrumentation";
import { interruptionObligationDirectory } from "./interruptionObligations";
import { adoptStructuredHostsAtStartup } from "./startup";
import { structuredStartupAxis } from "./startupStatus";

test("a busy interruption journal leaves startup responsive and the retry recovers", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "startup-interruption-admission-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = `${interruptionObligationDirectory(registry.filename)}.pending.jsonl`;
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const scheduled = Promise.withResolvers<void>();
  const refusedAgain = Promise.withResolvers<void>();
  const abort = new AbortController();
  const logs: unknown[][] = [];
  const retries: Array<() => void> = [];
  let holder: Promise<void> | undefined;
  const readSnapshot = registry.prepareReadOnlySnapshot.bind(registry);
  registry.prepareReadOnlySnapshot = async signal => {
    const snapshot = await readSnapshot(signal);
    // The peer publishes after initialization sealed the pending journal.
    // Startup must cross the journal fence again before trusting its census.
    holder ??= withFileTransaction(journal, "fixture journal is busy", async () => {
      fs.appendFileSync(journal, "\n");
      entered.resolve();
      await release.promise;
    });
    await Promise.race([entered.promise, holder]);
    return snapshot;
  };
  let startup: Promise<void> | undefined;
  try {
    const started = performance.now();
    startup = runStructuredHostStartup(() => adoptStructuredHostsAtStartup({
      registry, client: null, orchestratorSeats: () => [], signal: abort.signal,
    }), (...args) => logs.push(args), {
      jitterRatio: 0,
      signal: abort.signal,
      waitUntilReady: true,
      schedule: callback => {
        retries.push(callback);
        scheduled.resolve();
        if (retries.length > 1) refusedAgain.resolve();
        return { unref() {} };
      },
    });
    await Promise.race([startup, scheduled.promise]);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(retries).toHaveLength(1);
    expect(logs).toContainEqual([
      "[structured hosts] startup adoption failed; retry scheduled",
      expect.objectContaining({ category: "registry-contention", attempt: 1 }),
    ]);
    expect(fs.readdirSync(`${journal}.write-locks`)).toHaveLength(1);
    release.resolve();
    await holder;
    expect(fs.readdirSync(`${journal}.write-locks`)).toEqual([]);

    retries[0]!();
    await Promise.race([startup, refusedAgain.promise]);
    expect(retries).toHaveLength(1);
    expect(structuredStartupAxis()).toBe("ready");
    expect(logs).toContainEqual(["[structured hosts] startup adoption recovered", { attempts: 2 }]);
    expect(fs.existsSync(`${journal}.write-lock`)).toBe(false);
    expect(fs.readdirSync(`${journal}.write-locks`)).toEqual([]);
  } finally {
    abort.abort();
    release.resolve();
    await Promise.allSettled([startup, holder]);
    registry.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
