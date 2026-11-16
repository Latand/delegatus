import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importStateCollection } from "./sqliteStateStore";

for (const outcome of ["commit", "verification refusal", "projection refusal"] as const) {
  test(`state import releases its SQLite statements after ${outcome}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "state-import-handles-"));
    const filename = path.join(root, "state.sqlite");
    const close = Database.prototype.close;
    let closed = 0;
    // SQLite's default close can leave a zombie connection until outstanding
    // statements are collected. Strict close detects that on every platform.
    const closing = spyOn(Database.prototype, "close").mockImplementation(function (this: Database, strict?: boolean) {
      close.call(this, this.filename === filename ? true : strict);
      if (this.filename === filename) closed++;
    });
    try {
      const input = {
        collection: outcome === "projection refusal" ? "tasks" : "worktree_map",
        schemaVersion: 1, migrationId: "handle-lifetime",
        rows: [{ key: "checkout", value: { repo: "repository", worktree: "lane", dueAt: "2026-10-11T04:58:01.001Z" }, controllerActive: false }],
        sourceName: "worktree-map.json", sourceSha256: null, sourceBytes: 0, gap: null, release: null,
        beforeVerify: (execute: (sql: string) => void) => {
          if (outcome === "verification refusal") throw new Error("verification refused");
          if (outcome === "projection refusal") execute(`CREATE TRIGGER refuse_task_time BEFORE UPDATE OF task_due_ms ON state_rows
            BEGIN SELECT RAISE(ABORT, 'projection refused'); END`);
        },
      };
      if (outcome !== "commit") {
        expect(() => importStateCollection(filename, input)).toThrow(outcome.replace("refusal", "refused"));
        expect(closed).toBe(1);
        // Refused imports roll back their rows, marker and injected trigger.
        expect(importStateCollection(filename, { ...input, beforeVerify: undefined }).imported).toBe(true);
      } else {
        expect(importStateCollection(filename, input).imported).toBe(true);
        expect(importStateCollection(filename, input).imported).toBe(false);
      }
      expect(closed).toBe(2);
      if (process.platform === "linux") {
        const held = fs.readdirSync("/proc/self/fd").flatMap(fd => {
          try { return [fs.readlinkSync(`/proc/self/fd/${fd}`)]; } catch { return []; }
        }).filter(target => target.startsWith(root + path.sep));
        expect(held).toEqual([]);
      }
    } finally {
      closing.mockRestore();
      // Windows also verifies that no native file handle survived the import.
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
