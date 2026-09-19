import { Database } from "bun:sqlite";
import { createInterface } from "node:readline";

import { openCurrentDatabase } from "./currentDatabase";

/* A process that holds a connection to a state database through the
   production connection guard, the way the runtime host and MCP servers hold
   theirs, and writes on command. One JSON line answers each stdin line. */

const [filename, mode] = process.argv.slice(2);
if (!filename) throw new Error("database file argument is required");

const open = () => {
  const db = new Database(filename, { create: true, strict: true });
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  return db;
};
const reply = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const attempt = (operation: () => unknown) => {
  try {
    reply({ ok: true, value: operation() ?? null });
  } catch (error) {
    reply({ ok: false, error: error instanceof Error ? error.message : String(error), code: (error as { code?: unknown }).code ?? null });
  }
};

if (mode === "--open-once") {
  attempt(() => {
    const db = openCurrentDatabase(filename, open);
    try { return db.query<{ label: string }, []>("SELECT label FROM probe ORDER BY rowid").all().map((row) => row.label); } finally { db.close(); }
  });
  process.exit(0);
}

const db = openCurrentDatabase(filename, open);
const labels = () => db.query<{ label: string }, []>("SELECT label FROM probe ORDER BY rowid").all().map((row) => row.label);
reply({ ok: true, value: labels() });

createInterface({ input: process.stdin }).on("line", (line) => {
  const [command, argument] = line.split(" ");
  if (command === "begin") attempt(() => db.exec("BEGIN"));
  else if (command === "insert") attempt(() => db.query("INSERT INTO probe(label) VALUES (?)").run(argument ?? ""));
  else if (command === "commit") attempt(() => db.exec("COMMIT"));
  else if (command === "write") {
    attempt(() => {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.query("INSERT INTO probe(label) VALUES (?)").run(argument ?? "");
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* already closed */ }
        throw error;
      }
    });
  } else if (command === "labels") attempt(labels);
  else if (command === "exit") process.exit(0);
});
