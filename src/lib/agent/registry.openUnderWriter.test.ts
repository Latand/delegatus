import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";

import { AgentRegistry, normalizeRegistry } from "./registry";
import { SqliteAgentRegistryStore } from "./sqliteRegistryStore";

/*
 * A process that opened the agent registry while another writer held its
 * write lock failed with `database is locked` after the five-second busy
 * timeout, before it could read one row
 * (docs/design/viewer-stalls-root-cause.md, section 4.3). Opening a registry
 * whose schema is current asks for no write lock now. A second connection
 * holds `BEGIN IMMEDIATE` here while the registry is opened. Every database
 * is a private temporary file.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-open-under-writer-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const SESSION = "/sessions/opened-under-a-writer.jsonl";

function initialised(name: string): { filename: string; sqliteFilename: string; conversationId: ReturnType<AgentRegistry["ensureConversation"]>["id"] } {
  const directory = fs.mkdtempSync(path.join(root, `${name}-`));
  const filename = path.join(directory, "registry.json");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const conversationId = registry.ensureConversation("codex", SESSION, "account").id;
  registry.close();
  return { filename, sqliteFilename: path.join(directory, "registry.sqlite"), conversationId };
}

/** Opens the store as a process that may not run startup migrations does (an MCP server, a launcher). */
function openAsReader(sqliteFilename: string, options: { busyFailsAtOnce?: boolean } = {}): SqliteAgentRegistryStore {
  return new SqliteAgentRegistryStore(sqliteFilename, {
    normalize: normalizeRegistry,
    initialSnapshot: () => normalizeRegistry({ version: 2, entries: {}, receipts: {} }),
    allowArchiveMigration: false,
    deferColdKeyInitialization: options.busyFailsAtOnce,
  });
}

for (const opener of ["a process that may run startup migrations", "a process that may not"] as const) {
  test(`${opener} opens a current registry and reads it while another writer holds the write lock`, () => {
    const fixture = initialised("held");
    const peer = new Database(fixture.sqliteFilename);
    peer.exec("BEGIN IMMEDIATE");
    try {
      const startedAt = performance.now();
      if (opener === "a process that may not") {
        const store = openAsReader(fixture.sqliteFilename);
        try { expect(store.read(file => file.conversations[fixture.conversationId]?.generations[0]?.path)).toBe(SESSION); }
        finally { store.close(); }
      } else {
        const registry = new AgentRegistry(fixture.filename, undefined, undefined, { sqliteMode: "sqlite" });
        try { expect(registry.conversationForPath(SESSION)?.id).toBe(fixture.conversationId); }
        finally { registry.close(); }
      }
      /* The busy timeout is five seconds; an open that asked for the lock would still be waiting. */
      expect(performance.now() - startedAt).toBeLessThan(2_000);
      /* The other writer still holds the lock, and its transaction is intact. */
      peer.query("INSERT INTO registry_meta(key, value) VALUES ('held_by_peer', '1')").run();
    } finally {
      peer.exec("ROLLBACK");
      peer.close();
    }
  });
}

for (const behind of ["liveness_projection_version", "migration_complete"] as const) {
  test(`a registry behind at ${behind} still takes the write lock to bring it up to date`, () => {
    const fixture = initialised("behind");
    const peer = new Database(fixture.sqliteFilename);
    peer.query("DELETE FROM registry_meta WHERE key = ?").run(behind);
    peer.exec("BEGIN IMMEDIATE");
    let held = true;
    try {
      /* Something to install: the open must wait its turn, and refuses at once when it may not wait. */
      expect(() => openAsReader(fixture.sqliteFilename, { busyFailsAtOnce: true })).toThrow("database is locked");
      peer.exec("ROLLBACK");
      held = false;
      const store = openAsReader(fixture.sqliteFilename);
      try {
        expect(peer.query<{ value: string }, [string]>("SELECT value FROM registry_meta WHERE key = ?").get(behind)?.value)
          .toBe(behind === "migration_complete" ? "1" : "2");
        expect(store.imported()).toBe(true);
      } finally { store.close(); }
    } finally {
      if (held) peer.exec("ROLLBACK");
      peer.close();
    }
  });
}

test("a registry missing part of its archive schema installs it under the lock, and a complete one does not ask", () => {
  const fixture = initialised("archive");
  const peer = new Database(fixture.sqliteFilename);
  let held = false;
  try {
    peer.exec("DROP TRIGGER registry_signal_domain_delete");
    peer.exec("BEGIN IMMEDIATE");
    held = true;
    expect(() => new SqliteAgentRegistryStore(fixture.sqliteFilename, {
      normalize: normalizeRegistry, initialSnapshot: () => normalizeRegistry({ version: 2, entries: {}, receipts: {} }),
      deferColdKeyInitialization: true,
    })).toThrow("database is locked");
    peer.exec("ROLLBACK");
    held = false;
    new AgentRegistry(fixture.filename, undefined, undefined, { sqliteMode: "sqlite" }).close();
    expect(peer.query("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'registry_signal_domain_delete'").get()).not.toBeNull();
    peer.exec("BEGIN IMMEDIATE");
    held = true;
    new AgentRegistry(fixture.filename, undefined, undefined, { sqliteMode: "sqlite" }).close();
  } finally {
    if (held) peer.exec("ROLLBACK");
    peer.close();
  }
});

test("a registry that still carries a retired trigger is opened under the lock, which removes it", () => {
  const fixture = initialised("retired");
  const peer = new Database(fixture.sqliteFilename);
  let held = false;
  const retired = () => peer.query("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'registry_rows_ending_insert'").get();
  try {
    peer.exec("CREATE TRIGGER registry_rows_ending_insert AFTER INSERT ON registry_rows BEGIN SELECT 1; END");
    peer.exec("BEGIN IMMEDIATE");
    held = true;
    expect(() => new SqliteAgentRegistryStore(fixture.sqliteFilename, {
      normalize: normalizeRegistry, initialSnapshot: () => normalizeRegistry({ version: 2, entries: {}, receipts: {} }),
      deferColdKeyInitialization: true,
    })).toThrow("database is locked");
    peer.exec("ROLLBACK");
    held = false;
    expect(retired()).not.toBeNull();
    new AgentRegistry(fixture.filename, undefined, undefined, { sqliteMode: "sqlite" }).close();
    expect(retired()).toBeNull();
  } finally {
    if (held) peer.exec("ROLLBACK");
    peer.close();
  }
});

test("reopening a registry leaves its journal mode and auto-vacuum setting as they were created", () => {
  const fixture = initialised("pragmas");
  const peer = new Database(fixture.sqliteFilename, { readonly: true });
  const pragmas = () => ({
    autoVacuum: peer.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()?.auto_vacuum,
    journalMode: peer.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode,
  });
  try {
    const created = pragmas();
    expect(created.journalMode).toBe("wal");
    new AgentRegistry(fixture.filename, undefined, undefined, { sqliteMode: "sqlite" }).close();
    expect(pragmas()).toEqual(created);
  } finally { peer.close(); }
});
