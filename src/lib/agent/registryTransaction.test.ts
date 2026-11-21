import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { beginRegistryTransaction, RegistryTransactionError } from "./registryTransaction";

test.each([false, true])("transaction admission refuses an occupied connection before SQL, immediate=%s", immediate => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE effects (value TEXT)");
    beginRegistryTransaction(db);
    expect(() => beginRegistryTransaction(db, immediate)).toThrow(RegistryTransactionError);
    expect(db.inTransaction).toBe(true);
    expect(db.query("SELECT * FROM effects").all()).toEqual([]);
    db.exec("ROLLBACK");
    beginRegistryTransaction(db, immediate);
    db.exec("INSERT INTO effects VALUES ('admitted')");
    db.exec("COMMIT");
    expect(db.query("SELECT * FROM effects").all()).toEqual([{ value: "admitted" }]);
  } finally { db.close(); }
});

test("a native nested-BEGIN error retains its cause and names the retryable store", () => {
  const cause = new Error("cannot start a transaction within a transaction");
  const db = { inTransaction: false, exec: () => { throw cause; } };
  try { beginRegistryTransaction(db); throw new Error("expected refusal"); }
  catch (error) {
    expect(error).toBeInstanceOf(RegistryTransactionError);
    expect(error).toMatchObject({ code: "registry_transaction_busy", retryable: true, store: "SqliteAgentRegistryStore", cause });
    expect((error as Error).message).toContain("transient internal");
  }
  const other = new Error("unrelated SQLite failure");
  expect(() => beginRegistryTransaction({ inTransaction: false, exec: () => { throw other; } })).toThrow(other);
});
