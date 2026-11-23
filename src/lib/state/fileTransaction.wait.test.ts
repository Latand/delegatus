import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { blockingWaitDiagnostics, fileTransactionCallSite, registryWaitCallSite, resetBlockingWaitsForTests, withWaitCorrelation } from "@/lib/blockingWaits";
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

test("fileTransactionSubject, fileTransactionWaitLabel, holder.kind, and callSite enforce closed allowlists and verified source roots", () => {
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
    .toBe("seat-quota-recovery/<entry>");
  expect(fileTransactionSubject(`${statePrefix}/done-media/owner.lock`))
    .toBe("done-media/owner.lock");
  expect(fileTransactionSubject(`${statePrefix}/prototype-reviews/12345678-1234-1234-1234-123456789abc.polls.lock`))
    .toBe("prototype-reviews/<id>.polls.lock");
  expect(fileTransactionSubject(`/tmp/${syntheticEmail}/private/lifecycle-journal.json`))
    .toBe("lifecycle-journal.json");

  // Unknown parent directories or unknown filenames MUST collapse to "file-transaction" (never echo ids/names).
  expect(fileTransactionSubject(`${statePrefix}/fixture-account-017/owner.lock`))
    .toBe("file-transaction");
  expect(fileTransactionSubject(`${statePrefix}/private-handle/custom-store.json`))
    .toBe("file-transaction");

  // Wait labels come strictly from the closed set (never echo arbitrary busy messages or personal names).
  expect(fileTransactionWaitLabel("recorded check host custody", "recorded-check-host-fences/<slot>"))
    .toBe("recorded-check.host-custody");
  expect(fileTransactionWaitLabel("Fixture Person is busy", "file-transaction"))
    .toBe("file-transaction");
  expect(fileTransactionWaitLabel(`busy at ${syntheticHome}/secret`, "lifecycle-journal.json"))
    .toBe("lifecycle-journal.json");
  expect(fileTransactionWaitLabel(`${syntheticEmail} busy`, "lifecycle-journal.json"))
    .toBe("lifecycle-journal.json");
  expect(fileTransactionWaitLabel("arbitrary message", "file-transaction", "unknown.custom.label"))
    .toBe("file-transaction");
  expect(fileTransactionWaitLabel("fallback", "lifecycle-journal.json", "recorded-check.handoff"))
    .toBe("recorded-check.handoff");

  // Only frames strictly inside the verified repository/build root are emitted;
  // external callers (even under dist/, src/lib/, or .next/server/) collapse to "external" / "unresolved".
  const repoRoot = path.resolve(import.meta.dir, "../../..");
  expect(fileTransactionCallSite(
    `Error\n    at waiter (${repoRoot}/src/lib/recordedChecks/hostFence.ts:19:10)`,
  )).toBe("src/lib/recordedChecks/hostFence.ts:19:10");
  expect(registryWaitCallSite(
    `Error\n    at waiter (${repoRoot}/src/lib/recordedChecks/hostFence.ts:19:10)`,
  )).toBe("src/lib/recordedChecks/hostFence.ts:19:10");
  for (const externalFrame of [
    "/tmp/dist/fixture-account-319/review-owner.ts:1:65",
    "/tmp/src/lib/fixture-account-319/review-owner.ts:1:65",
    "/tmp/.next/server/fixture-account-319/review-owner.ts:1:65",
    "/tmp/src/fixture-private-project/checkout/src/lib/recordedChecks/hostFence.ts:19:10",
    "/tmp/src/fixture-private-project/customScript.ts:19:10",
  ]) {
    expect(fileTransactionCallSite(`Error\n    at outside (${externalFrame})`)).toBe("external");
    expect(registryWaitCallSite(`Error\n    at outside (${externalFrame})`)).toBe("unresolved");
  }
});

test("concurrent async waiters without withWaitCorrelation record closed-set subject, label, callSite, and holder, and isolate caller mutations", async () => {
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
      expect(sample.label).toBe("recorded-check.host-custody");
      expect(sample.holder).toMatchObject({ kind: "viewer", sameProcess: true });
      expect(sample.holder!.ageMs).toBeGreaterThanOrEqual(0);
      expect(sample.callSite).toContain("src/lib/state/fileTransaction.wait.test.ts:");
      if (process.env.HOME) expect(sample.callSite).not.toContain(process.env.HOME);
    }
    expect(lines.some((line) => line.includes("recorded-check-host-fences/<slot>") && line.includes("recorded-check.host-custody"))).toBe(true);

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

test("cross-process, legacy, and arbitrary-role lock holders never leak paths, names, or unknown roles", async () => {
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
      label: "recorded-check.handoff",
      holder: { kind: "worker", sameProcess: false },
    });
  } finally {
    fs.writeFileSync(holdStop, "stop");
    await child.exited.catch(() => {});
  }

  // 2. Arbitrary account path + arbitrary busy message + arbitrary holder role MUST redact all three!
  const leakLines: string[] = [];
  resetBlockingWaitsForTests((line) => { leakLines.push(line); });
  const leakDir = path.join(root, "fixture-account-017");
  fs.mkdirSync(leakDir, { recursive: true });
  const leakFile = path.join(leakDir, "owner.lock");
  const leakLock = `${leakFile}.write-lock`;
  fs.writeFileSync(leakLock, JSON.stringify({
    pid: process.ppid,
    startIdentity: null,
    token: "arbitrary-token",
    role: "fixture-holder-019",
  }));
  setTimeout(() => fs.rmSync(leakLock, { force: true }), 80);
  expect(await withFileTransactionAsync(leakFile, "Fixture Person lock busy", () => "ok")).toBe("ok");
  const leakSample = blockingWaitDiagnostics().longest.find((item) => item.site === "file-transaction");
  expect(leakSample).toMatchObject({
    site: "file-transaction",
    subject: "file-transaction",
    label: "file-transaction",
    holder: { kind: "other-process", sameProcess: false },
  });
  const combinedLogs = leakLines.join("\n");
  expect(combinedLogs).not.toContain("fixture-account-017");
  expect(combinedLogs).not.toContain("Fixture Person");
  expect(combinedLogs).not.toContain("fixture-holder-019");
});

test("external callers under id-bearing directories log callSite='external' with zero private path segments", async () => {
  const fileTransactionModule = path.resolve(import.meta.dir, "fileTransaction.ts");
  const blockingWaitsModule = path.resolve(import.meta.dir, "../blockingWaits.ts");
  const variants = [
    "dist/fixture-account-319",
    "src/lib/fixture-account-319",
    ".next/server/fixture-account-319",
    "external-dir/fixture-account-319",
  ];
  for (const relDir of variants) {
    const callerDir = path.join(root, relDir);
    fs.mkdirSync(callerDir, { recursive: true });
    const callerScript = path.join(callerDir, "review-owner.ts");
    const lockTarget = path.join(callerDir, "owner.lock");
    fs.writeFileSync(callerScript, [
      `import { withFileTransactionAsync } from ${JSON.stringify(fileTransactionModule)};`,
      `import { resetBlockingWaitsForTests } from ${JSON.stringify(blockingWaitsModule)};`,
      `const lines: string[] = [];`,
      `resetBlockingWaitsForTests((line) => { lines.push(line); });`,
      `let release!: () => void;`,
      `const barrier = new Promise<void>((r) => { release = r; });`,
      `let ready!: () => void;`,
      `const entered = new Promise<void>((r) => { ready = r; });`,
      `const h = withFileTransactionAsync(${JSON.stringify(lockTarget)}, "external busy fixture-account-319", async () => { ready(); await barrier; });`,
      `await entered;`,
      `const w = withFileTransactionAsync(${JSON.stringify(lockTarget)}, "external busy fixture-account-319", async () => "ok");`,
      `await new Promise((r) => setTimeout(r, 80));`,
      `release();`,
      `await Promise.all([h, w]);`,
      `console.log(JSON.stringify(lines));`,
    ].join("\n"));

    const proc = Bun.spawn([process.execPath, callerScript], {
      env: { ...process.env, LLV_STATE_OWNER: "viewer" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect({ relDir, exitCode, stderr }).toMatchObject({ relDir, exitCode: 0 });
    const emitted = JSON.parse(stdout.trim().split("\n").at(-1)!) as string[];
    const waitLines = emitted.filter((line) => line.startsWith("[blocking-wait] "));
    expect(waitLines.length).toBeGreaterThanOrEqual(1);
    for (const line of waitLines) {
      expect(line).not.toContain("fixture-account-319");
      expect(line).not.toContain("review-owner");
      expect(line).not.toContain(root);
      const parsed = JSON.parse(line.slice("[blocking-wait] ".length)) as {
        site: string;
        subject: string | null;
        label: string | null;
        callSite?: string;
        holder?: { kind?: string };
      };
      expect(parsed).toMatchObject({
        site: "file-transaction",
        subject: "file-transaction",
        label: "file-transaction",
        callSite: "external",
        holder: { kind: "viewer" },
      });
    }
  }
});
