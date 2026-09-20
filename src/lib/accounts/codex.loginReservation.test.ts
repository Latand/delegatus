import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, spyOn, test } from "bun:test";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-login-reservation-"));
const savedEnv = { ...process.env };
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
process.env.LLV_CODEX_HOME = path.join(sandbox, "codex");
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(sandbox, { recursive: true, force: true });
});
const { createManagedCodexAccount, withManagedCodexLogin, codexAccountLoginBusy, CodexLoginBusyError } = await import("./codex");
const { persistedAccountRegistry, seedAccountRegistry } = await import("./accountsStoreFixture");
const store = await import("./accountsStore");
const { procBackend } = await import("@/lib/proc");

type Reservation = { token: string; pid: number; identity: string | null; namespace: string | null; bootId: string | null };
function reservation(id: string): Reservation | null {
  return (persistedAccountRegistry("codex").accounts.find((item) => item.id === id) as { loginReservation?: Reservation }).loginReservation ?? null;
}
function replace(id: string, value: Reservation | null) {
  const registry = persistedAccountRegistry("codex");
  seedAccountRegistry("codex", { ...registry, accounts: registry.accounts.map((item) => item.id === id ? { ...item, loginReservation: value } : item) });
}

for (const kind of ["dead-owner", "reused-pid", "foreign-owner", "unknown-owner"] as const) {
  test(`login reservation handles ${kind} without releasing an unverified owner`, async () => {
    const account = createManagedCodexAccount(kind);
    let owner!: Reservation;
    await withManagedCodexLogin(account, async () => { owner = reservation(account.id)!; });
    if (kind === "foreign-owner") owner.namespace = "pid:[fixture-foreign]";
    if (kind === "unknown-owner") owner.identity = null;
    if (kind === "reused-pid") owner.identity = "old-process";
    replace(account.id, owner);
    const alive = spyOn(procBackend, "pidAlive").mockReturnValue(kind !== "dead-owner");
    try {
      if (kind === "foreign-owner" || kind === "unknown-owner") {
        await expect(withManagedCodexLogin(account, async () => undefined)).rejects.toBeInstanceOf(CodexLoginBusyError);
        expect(reservation(account.id)?.token).toBe(owner.token);
      } else {
        await expect(withManagedCodexLogin(account, async () => "recovered")).resolves.toBe("recovered");
        expect(codexAccountLoginBusy(account.id)).toBeFalse();
      }
    } finally { alive.mockRestore(); replace(account.id, null); }
  });
}

test("completion retries a failed write without abandoning its reservation", async () => {
  const account = createManagedCodexAccount("Completion retry");
  const write = store.writeAccountSource;
  let operationDone = false, failed = false;
  const injected = spyOn(store, "writeAccountSource").mockImplementation((...args) => {
    if (operationDone && !failed) { failed = true; throw new Error("transient fixture write failure"); }
    return write(...args);
  });
  try {
    await expect(withManagedCodexLogin(account, async () => { operationDone = true; return "completed"; })).resolves.toBe("completed");
    expect(failed).toBeTrue();
    expect(codexAccountLoginBusy(account.id)).toBeFalse();
  } finally { injected.mockRestore(); }
});

test("a stale completion never clears a replacement token", async () => {
  const account = createManagedCodexAccount("Replacement token");
  await expect(withManagedCodexLogin(account, async () => {
    replace(account.id, { ...reservation(account.id)!, token: "newer-reservation" });
  })).rejects.toThrow("reservation changed");
  expect(reservation(account.id)?.token).toBe("newer-reservation");
  replace(account.id, null);
});
