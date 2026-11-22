import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { blockingWaitDiagnostics, resetBlockingWaitsForTests, withWaitCorrelation } from "@/lib/blockingWaits";
import {
  FileTransactionBusyError,
  fileTransactionSubject,
  fileTransactionWaitLabel,
  withFileTransaction,
  withFileTransactionAsync,
  withFileTransactionSync,
} from "./fileTransaction";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "file-wait-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
for (const fails of [false, true]) test(`file admission yields and records its origin when the body ${fails ? "throws" : "succeeds"}`, async () => {
  const lines: string[] = [];
  resetBlockingWaitsForTests(line => { lines.push(line); });
  const file = path.join(root, `wait-${fails}.json`);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let ready!: () => void;
  const admitted = new Promise<void>(resolve => { ready = resolve; });
  const holder = withFileTransaction(file, "held", async () => { ready(); await barrier; });
  await admitted;
  let timerAdvanced = false;
  const timer = setTimeout(() => { timerAdvanced = true; release(); }, 100);
  try {
    const result = withWaitCorrelation({ label: "account-credit-guard.obligations" }, () =>
      withFileTransaction(file, "busy", () => { if (fails) throw new Error("body refused"); return "written"; }));
    if (fails) await expect(result).rejects.toThrow("body refused");
    else expect(await result).toBe("written");
    expect(timerAdvanced).toBe(true);
    expect(blockingWaitDiagnostics().longest).toContainEqual(expect.objectContaining({ site: "file-transaction",
      synchronous: false, label: "account-credit-guard.obligations" }));
    expect(lines.some(line => line.includes("file-transaction") && line.includes("account-credit-guard.obligations"))).toBe(true);
    expect(await withFileTransaction(file, "busy", () => "released")).toBe("released");
  } finally { clearTimeout(timer); release(); await holder; }
});

test("a sync writer in the same process fails fast behind an async owner", async () => {
  const file = path.join(root, "mixed-lock.json");
  let observed!: (error: unknown) => void;
  const attempt = new Promise<unknown>(resolve => { observed = resolve; });
  let syncActionRan = false;
  const asyncWrite = withFileTransactionAsync(file, "async held", () => {
    queueMicrotask(() => {
      try { withFileTransactionSync(file, "sync busy", () => { syncActionRan = true; return "written"; }); }
      catch (error) { observed(error); }
    });
    return "async written";
  });
  expect(await asyncWrite).toBe("async written");
  expect(await attempt).toBeInstanceOf(FileTransactionBusyError);
  expect(syncActionRan).toBeFalse();
  const started = performance.now();
  expect(withFileTransactionSync(file, "sync busy", () => { syncActionRan = true; return "after release"; }))
    .toBe("after release");
  expect(performance.now() - started).toBeLessThan(50);
  expect(syncActionRan).toBeTrue();
});

test("the shared async API releases a synchronous callback before a queued sync writer runs", async () => {
  const file = path.join(root, "mixed-sync-callback.json");
  let observed!: (error: unknown) => void;
  const attempt = new Promise<unknown>(resolve => { observed = resolve; });
  const asyncWrite = withFileTransaction(file, "async held", () => {
    queueMicrotask(() => {
      try { observed(withFileTransactionSync(file, "sync busy", () => "written")); }
      catch (error) { observed(error); }
    });
    return "async written";
  });
  expect(await asyncWrite).toBe("async written");
  expect(await attempt).toBe("written");
});

test("fileTransactionSubject and fileTransactionWaitLabel strip home paths, emails, UUIDs, hashes, and numeric slots", () => {
  const statePrefix = path.posix.join("/", "var", "fixture-user", ".config", "delegatus", "state");
  const syntheticHome = ["", "home", "fixture-user"].join("/");
  const syntheticEmail = ["fixture-user", "example.invalid"].join("@");

  expect(fileTransactionSubject(`${statePrefix}/attempt-temp.sqlite.sweep`))
    .toBe("attempt-temp.sqlite.sweep");
  expect(fileTransactionSubject(`${syntheticHome}/.config/delegatus/state/recorded-check-host-fences/14`))
    .toBe("recorded-check-host-fences/<slot>");
  expect(fileTransactionSubject(`${statePrefix}/recorded-check-observers/7`))
    .toBe("recorded-check-observers/<slot>");
  expect(fileTransactionSubject(`${statePrefix}/seat-quota-recovery/40e715252667dc64f60fbea3a72d081dbe95de533df85f112022c836a9af4b53.json`))
    .toBe("seat-quota-recovery/<id>.json");
  expect(fileTransactionSubject(`${statePrefix}/done-media/owner.lock`))
    .toBe("done-media/owner.lock");
  expect(fileTransactionSubject(`${statePrefix}/prototype-reviews/12345678-1234-1234-1234-123456789abc.polls.lock`))
    .toBe("prototype-reviews/<id>.polls.lock");
  expect(fileTransactionSubject(`/tmp/${syntheticEmail}/private/lifecycle-journal.json`))
    .toBe("lifecycle-journal.json");

  expect(fileTransactionWaitLabel("recorded check host custody", "recorded-check-host-fences/<slot>"))
    .toBe("recorded check host custody");
  expect(fileTransactionWaitLabel(`busy at ${syntheticHome}/secret`, "lifecycle-journal.json"))
    .toBe("lifecycle-journal.json");
  expect(fileTransactionWaitLabel(`${syntheticEmail} busy`, "lifecycle-journal.json"))
    .toBe("lifecycle-journal.json");
  expect(fileTransactionWaitLabel("fallback", "lifecycle-journal.json", "custom.label"))
    .toBe("custom.label");
});

test("concurrent async waiters without withWaitCorrelation record privacy-safe subject, label, callSite, and holder, and isolate caller mutations", async () => {
  const lines: string[] = [];
  resetBlockingWaitsForTests((line) => { lines.push(line); });
  const prevOwner = process.env.LLV_STATE_OWNER;
  process.env.LLV_STATE_OWNER = "viewer";
  try {
    const dir = path.join(root, "recorded-check-host-fences");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "14");
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const holderReady = new Promise<void>((resolve) => { entered = resolve; });

    const holder = withFileTransactionAsync(file, "recorded check host custody", async () => {
      entered();
      await barrier;
      return "holder";
    });
    await holderReady;

    const waiters = [1, 2].map((index) =>
      withFileTransactionAsync(file, "recorded check host custody", async () => `waiter-${index}`),
    );
    await new Promise((resolve) => setTimeout(resolve, 90));
    release();
    expect(await Promise.all([holder, ...waiters])).toEqual(["holder", "waiter-1", "waiter-2"]);

    const diagnostics = blockingWaitDiagnostics();
    const samples = diagnostics.longest.filter((sample) => sample.site === "file-transaction");
    expect(samples.length).toBeGreaterThanOrEqual(2);
    for (const sample of samples) {
      expect(sample.subject).toBe("recorded-check-host-fences/<slot>");
      expect(sample.label).toBe("recorded check host custody");
      expect(sample.holder).toMatchObject({ kind: "viewer", sameProcess: true });
      expect(sample.holder!.ageMs).toBeGreaterThanOrEqual(0);
      expect(sample.callSite).toContain("src/lib/state/fileTransaction.wait.test.ts:");
      if (process.env.HOME) expect(sample.callSite).not.toContain(process.env.HOME);
    }
    expect(lines.some((line) => line.includes("recorded-check-host-fences/<slot>") && line.includes("recorded check host custody"))).toBe(true);

    // Caller mutating returned diagnostics objects must not corrupt stored samples.
    samples[0]!.subject = "corrupted-subject";
    samples[0]!.holder!.kind = "corrupted-kind";
    const fresh = blockingWaitDiagnostics().longest.find((sample) => sample.site === "file-transaction");
    expect(fresh?.subject).toBe("recorded-check-host-fences/<slot>");
    expect(fresh?.holder?.kind).toBe("viewer");
  } finally {
    if (prevOwner === undefined) delete process.env.LLV_STATE_OWNER;
    else process.env.LLV_STATE_OWNER = prevOwner;
  }
});

test("cross-process and legacy lock holders report remote kind without leaking paths or secrets", async () => {
  const lines: string[] = [];
  resetBlockingWaitsForTests((line) => { lines.push(line); });

  // 1. Live cross-process holder writing modern LockOwner with role="worker".
  const crossFile = path.join(root, "attempt-temp.sqlite.sweep");
  const holdReady = path.join(root, "hold-ready");
  const holdStop = path.join(root, "hold-stop");
  const child = Bun.spawn([
    process.execPath,
    "-e",
    `import fs from "node:fs";
     import { withFileTransactionAsync } from ${JSON.stringify(path.resolve("src/lib/state/fileTransaction.ts"))};
     await withFileTransactionAsync(${JSON.stringify(crossFile)}, "attempt-temp sweep admission", async () => {
       fs.writeFileSync(${JSON.stringify(holdReady)}, "ready");
       while (!fs.existsSync(${JSON.stringify(holdStop)})) await new Promise(r => setTimeout(r, 10));
     });`,
  ], {
    env: { ...process.env, LLV_STATE_OWNER: "worker" },
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    const waitReady = Date.now() + 5_000;
    while (!fs.existsSync(holdReady) && Date.now() < waitReady) await new Promise((r) => setTimeout(r, 10));
    expect(fs.existsSync(holdReady)).toBe(true);

    const waiter = withFileTransactionAsync(crossFile, "recorded-check handoff", () => "admitted");
    await new Promise((r) => setTimeout(r, 80));
    fs.writeFileSync(holdStop, "stop");
    expect(await waiter).toBe("admitted");
    expect(await child.exited).toBe(0);

    const sample = blockingWaitDiagnostics().longest.find((item) => item.subject === "attempt-temp.sqlite.sweep");
    expect(sample).toMatchObject({
      site: "file-transaction",
      subject: "attempt-temp.sqlite.sweep",
      label: "recorded-check handoff",
      holder: { kind: "worker", sameProcess: false },
    });
  } finally {
    fs.writeFileSync(holdStop, "stop");
    await child.exited.catch(() => {});
  }

  // 2. Legacy lock file written without `role` falls back cleanly to kind="other-process".
  resetBlockingWaitsForTests();
  const legacyFile = path.join(root, "legacy-store.json");
  const legacyLock = `${legacyFile}.write-lock`;
  // Use a live non-self PID (parent process) so ownerIsStale treats the lock as live.
  fs.writeFileSync(legacyLock, JSON.stringify({ pid: process.ppid, startIdentity: null, token: "legacy-token" }));
  setTimeout(() => fs.rmSync(legacyLock, { force: true }), 80);
  expect(await withFileTransactionAsync(legacyFile, "legacy store busy", () => "ok")).toBe("ok");
  const legacySample = blockingWaitDiagnostics().longest.find((item) => item.subject === "legacy-store.json");
  expect(legacySample).toMatchObject({
    site: "file-transaction",
    subject: "legacy-store.json",
    label: "legacy store busy",
    holder: { kind: "other-process", sameProcess: false },
  });
});
