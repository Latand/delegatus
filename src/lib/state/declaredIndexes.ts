import type { Database } from "bun:sqlite";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { assertStateStartupMutation } from "@/lib/stateOwnership";

/** The readiness check and repair use the same DDL as a fresh installation. */
export function declaredIndexes(statements: readonly string[]) {
  const names = statements.map(sql => {
    const name = /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/.exec(sql)?.[1];
    if (!name) throw new Error("index declaration requires IF NOT EXISTS");
    return name;
  });
  return {
    statements,
    assertRepairAuthority(db: Database, directory: string): void {
      const existing = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => row.name));
      if (!names.every(name => existing.has(name))) assertStateStartupMutation(directory, "SQLite index repair");
    },
    ready(objects: ReadonlySet<string>): boolean { return names.every(name => objects.has(name)); },
    install(db: Database, directory: string): void {
      const existing = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => row.name));
      const missing = statements.filter((_, index) => !existing.has(names[index]!));
      if (!missing.length) return;
      assertStateStartupMutation(directory, "SQLite index repair");
      withViewerOperation("state.index-repair", () => {
        for (const sql of missing) db.exec(sql);
      });
    },
  };
}
