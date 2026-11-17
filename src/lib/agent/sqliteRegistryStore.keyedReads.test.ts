import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { normalizeRegistry } from "./registry";
import { SqliteAgentRegistryStore } from "./sqliteRegistryStore";

const directories: string[] = [];
const stores: SqliteAgentRegistryStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "registry-keyed-reads-"));
  directories.push(directory);
  const initial = normalizeRegistry({ version: 2, entries: {}, receipts: Object.fromEntries(
    ["first", "second", "third"].map(launchId => [launchId, {
      launchId, conversationId: `conversation_${launchId}`, engine: "codex", cwd: "/registry-fixture",
      createdAt: "2026-10-01T00:00:00.000Z", state: "starting", error: null,
      pathCorrelation: { cwd: "/registry-fixture", startedAt: "2026-10-01T00:00:00.000Z" },
      launchProfile: emptyLaunchProfile({ cwd: "/registry-fixture", title: "Exercise keyed registry reads", mcpServers: ["viewer"] }),
    }]),
  ) });
  const store = new SqliteAgentRegistryStore(path.join(directory, "registry.sqlite"), {
    initialSnapshot: initial, normalize: normalizeRegistry,
  });
  stores.push(store);
  return { store, initial };
}

for (const cached of [false, true]) {
  for (const enumerate of [false, true]) {
    test(`keyed reads isolate nested values and preserve every field (cache=${cached}, enumerate=${enumerate})`, () => {
      const { store, initial } = fixture();
      const options = { skipColdKeyInitialization: !cached };
      const read = () => store.read(file => {
        // Enumeration exercises the unloaded siblings after a keyed read.
        const first = file.receipts.first!;
        expect(file.receipts.missing).toBeUndefined();
        return enumerate ? Object.values(file.receipts) : [first];
      }, options);
      const expected = JSON.stringify(enumerate ? Object.values(initial.receipts) : [initial.receipts.first]);
      // Warm the parsed-row cache before counting and mutating caller values.
      expect(JSON.stringify(read())).toBe(expected);
      const clones = spyOn(globalThis, "structuredClone");
      let rows: ReturnType<typeof read>;
      try {
        rows = read();
        expect(clones).toHaveBeenCalledTimes(cached ? (enumerate ? 3 : 1) : 0);
      } finally { clones.mockRestore(); }
      expect(JSON.stringify(rows)).toBe(expected);
      for (const row of rows) row.pathCorrelation!.cwd = "/caller-mutation";
      expect(JSON.stringify(read())).toBe(expected);
    });
  }

  test(`a thrown reader leaves subsequent reads and writes intact (cache=${cached})`, () => {
    const { store, initial } = fixture();
    const options = { skipColdKeyInitialization: !cached };
    expect(() => store.read(file => {
      file.receipts.first!.pathCorrelation!.cwd = "/discarded-change";
      throw new Error("reader refused");
    }, options)).toThrow("reader refused");
    expect(store.read(file => file.receipts.first, options)).toEqual(initial.receipts.first);
    store.mutate(file => { file.receipts.first!.error = "committed"; }, false);
    expect(store.read(file => file.receipts.first!.error, options)).toBe("committed");
  });
}
