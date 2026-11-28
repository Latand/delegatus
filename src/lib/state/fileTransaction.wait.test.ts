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
    // Missing files under allowed prefixes inside the repo root MUST NOT leak lexical path segments.
    `${repoRoot}/.next/server/chunks/fixture-private-741/old.js:1:2`,
    `${repoRoot}/src/lib/fixture-private-741/missing.ts:1:2`,
    `${repoRoot}/dist/fixture-private-741/missing.js:1:2`,
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

test("explicit untrusted withWaitCorrelation labels, operationId suffixes, and custom roles are redacted on admission and refusal", async () => {
  const prevOwner = process.env.LLV_STATE_OWNER;
  const tag = "fixture-account-729";
  const customRole = "fixture-caller-727";
  const person = "Fixture Person";
  const holderRole = "fixture-worker-728";
  const lockFile = path.join(root, tag, "owner.lock");
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  try {
    for (const [callerRole, expectedRole] of [["test", "test"], [customRole, "unowned"]] as const) {
      process.env.LLV_STATE_OWNER = callerRole;
      for (const kind of ["admit", "refuse"] as const) {
        const lines: string[] = [];
        resetBlockingWaitsForTests((line) => { lines.push(line); });
        fs.writeFileSync(`${lockFile}.write-lock`, JSON.stringify({
          pid: process.ppid,
          startIdentity: null,
          token: "held",
          role: holderRole,
        }));
        let calls = 0;
        let refused = false;
        const timer = kind === "admit"
          ? setTimeout(() => fs.rmSync(`${lockFile}.write-lock`, { force: true }), 80)
          : null;
        try {
          await withWaitCorrelation(
            { label: person, operationId: `account-removal:claude:${tag}` },
            () => withFileTransactionAsync(lockFile, person, () => { calls += 1; }, { waitMs: kind === "admit" ? 600 : 100 }),
          );
        } catch (error) {
          if (!(error instanceof FileTransactionBusyError)) throw error;
          refused = true;
        } finally {
          if (timer) clearTimeout(timer);
          fs.rmSync(`${lockFile}.write-lock`, { force: true });
        }
        expect(refused).toBe(kind === "refuse");
        expect(calls).toBe(kind === "admit" ? 1 : 0);
        expect(lines.length).toBeGreaterThan(0);
        const combined = lines.join("\n");
        expect(combined).not.toContain(tag);
        expect(combined).not.toContain(person);
        expect(combined).not.toContain(holderRole);
        expect(combined).not.toContain(customRole);
        const row = JSON.parse(lines[0]!.slice("[blocking-wait] ".length)) as {
          subject: string;
          label: string;
          operationId: string | null;
          role: string;
          holder?: { kind: string };
        };
        expect(row).toMatchObject({
          subject: "file-transaction",
          label: "file-transaction",
          operationId: "account-removal",
          role: expectedRole,
          holder: { kind: "other-process" },
        });
      }
    }

    // Unknown operationId prefix (not in closed set) is dropped completely (null).
    const unknownLines: string[] = [];
    resetBlockingWaitsForTests((line) => { unknownLines.push(line); });
    fs.writeFileSync(`${lockFile}.write-lock`, JSON.stringify({ pid: process.ppid, startIdentity: null, token: "t2", role: "worker" }));
    setTimeout(() => fs.rmSync(`${lockFile}.write-lock`, { force: true }), 80);
    await withWaitCorrelation(
      { label: "external-account-134", operationId: "untrusted-prefix:secret-id" },
      () => withFileTransactionAsync(lockFile, "arbitrary busy", () => "ok"),
    );
    expect(unknownLines.join("\n")).not.toContain("external-account-134");
    expect(unknownLines.join("\n")).not.toContain("untrusted-prefix");
    expect(unknownLines.join("\n")).not.toContain("secret-id");
    expect(blockingWaitDiagnostics().longest[0]).toMatchObject({
      site: "file-transaction",
      label: "file-transaction",
      operationId: null,
    });
  } finally {
    resetBlockingWaitsForTests();
    if (prevOwner === undefined) delete process.env.LLV_STATE_OWNER;
    else process.env.LLV_STATE_OWNER = prevOwner;
  }
});

test("synchronous writer never runs diagnostic stat between attempts or delays admission after lock release", async () => {
  const file = path.join(root, "sync-slow-metadata");
  const lock = `${file}.write-lock`;
  const ready = `${file}.ready`;
  const stamp = `${file}.stamp`;
  const worker = path.join(root, "sync-release-worker.ts");
  fs.writeFileSync(worker, [
    'import fs from "node:fs";',
    'const [lockPath, readyPath, stampPath] = process.argv.slice(2);',
    'fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "fixture", startIdentity: null, role: "test" }));',
    'fs.writeFileSync(readyPath, "1");',
    'await Bun.stdin.text();',
    'await Bun.sleep(65);',
    'fs.unlinkSync(lockPath);',
    'fs.writeFileSync(stampPath, String(Date.now()));',
  ].join("\n"));

  const child = Bun.spawn([process.execPath, worker, lock, ready, stamp], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });
  const originalStatSync = fs.statSync;
  let lockStatCalls = 0;
  let ran = 0;
  let admittedAt = 0;
  try {
    const deadline = Date.now() + 3_000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await Bun.sleep(5);
    expect(fs.existsSync(ready)).toBe(true);
    fs.statSync = (function (target: fs.PathLike, ...args: unknown[]) {
      const value = (originalStatSync as (...a: unknown[]) => fs.Stats).call(fs, target, ...args);
      if (String(target) === lock) {
        lockStatCalls += 1;
        Bun.sleepSync(320);
      }
      return value;
    }) as typeof fs.statSync;
    const t0 = Date.now();
    child.stdin.end();
    withFileTransactionSync(file, "fixture busy", () => {
      ran += 1;
      admittedAt = Date.now() - t0;
    });
    expect(await child.exited).toBe(0);
    const releasedAt = Number(fs.readFileSync(stamp, "utf8")) - t0;
    expect(ran).toBe(1);
    expect(lockStatCalls).toBe(0);
    expect(admittedAt - releasedAt).toBeLessThan(170);
  } finally {
    fs.statSync = originalStatSync;
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
    }
    fs.rmSync(lock, { force: true });
  }
});

test("slow diagnostic holder metadata never delays lock admission or causes FileTransactionBusyError", async () => {
  const fsp = (await import("node:fs/promises")).default;
  const originalStat = fsp.stat;
  const file = path.join(root, "slow-metadata-admission.json");
  const lock = `${file}.write-lock`;
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startIdentity: null, role: "test", token: "fixture-slow-stat" }));
  let statCalls = 0;
  let ran = 0;
  fsp.stat = (async function (this: typeof fsp, target: fs.PathLike, ...args: unknown[]) {
    const result = await (originalStat as (...a: unknown[]) => Promise<fs.Stats>).call(this, target, ...args);
    if (String(target) === lock) {
      statCalls += 1;
      await Bun.sleep(320);
    }
    return result;
  }) as typeof fsp.stat;
  const timer = setTimeout(() => { fs.rmSync(lock, { force: true }); }, 65);
  const started = performance.now();
  try {
    await withFileTransactionAsync(file, "fixture busy", () => { ran += 1; }, { waitMs: 230 });
    const elapsed = performance.now() - started;
    expect(ran).toBe(1);
    expect(elapsed).toBeLessThan(220);
    expect(statCalls).toBeGreaterThanOrEqual(1);
  } finally {
    clearTimeout(timer);
    fsp.stat = originalStat;
    fs.rmSync(lock, { force: true });
  }
});

for (const point of ["ticket", "lock"] as const) test(`a process exit at ${point} creation leaves no owner that can block the next contender`, async () => {
  const file = path.join(root, `owner-publication-${point}`);
  const ready = file + ".ready";
  const child = Bun.spawn([process.execPath, "-e", `
    import fs from "node:fs";
    import fsp from "node:fs/promises";
    import { withFileTransactionAsync } from ${JSON.stringify(new URL("./fileTransaction.ts", import.meta.url).pathname)};
    const [file, ready, point] = process.argv.slice(1);
    const waitForExit = async () => {
      fs.writeFileSync(ready, "");
      await Bun.sleep(15_000);
    };
    const open = fsp.open.bind(fsp);
    fsp.open = async (target, flags, ...args) => {
      const handle = await open(target, flags, ...args);
      const pathname = String(target);
      if (flags === "wx" && (point === "ticket" ? pathname.startsWith(file + ".write-locks/") : pathname === file + ".write-lock")) {
        await waitForExit();
      }
      return handle;
    };
    const link = fsp.link.bind(fsp);
    fsp.link = async (from, target) => {
      await link(from, target);
      if (point === "lock" && String(target) === file + ".write-lock") await waitForExit();
    };
    await withFileTransactionAsync(file, "fixture journal writer", () => { throw new Error("writer crossed the crash barrier"); });
  `, file, ready, point], { stdout: "ignore", stderr: "inherit" });
  try {
    const handshake = performance.now() + 2_000;
    while (!fs.existsSync(ready) && child.exitCode === null && performance.now() < handshake) await Bun.sleep(5);
    expect(fs.existsSync(ready)).toBe(true);
    child.kill("SIGKILL");
    await child.exited;

    const started = performance.now();
    expect(await withFileTransactionAsync(file, "fixture journal waiter", () => "admitted", { waitMs: 4_500 })).toBe("admitted");
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(fs.existsSync(file + ".write-lock")).toBe(false);
    expect(fs.readdirSync(file + ".write-locks")).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}, 12_000);

test("published tickets keep live writers in admission order", async () => {
  const file = path.join(root, "live-owner-order");
  const release = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const order: string[] = [];
  const holder = withFileTransactionAsync(file, "live journal owner", async () => {
    held.resolve();
    await release.promise;
  });
  await held.promise;
  const first = withFileTransactionAsync(file, "first journal waiter", () => { order.push("first"); }, { waitMs: 2_000 });
  let second: Promise<void> | undefined;
  try {
    const deadline = performance.now() + 1_000;
    while (fs.readdirSync(file + ".write-locks").filter(name => name.endsWith(".json")).length !== 2
      && performance.now() < deadline) await Bun.sleep(5);
    expect(fs.readdirSync(file + ".write-locks").filter(name => name.endsWith(".json"))).toHaveLength(2);
    await Bun.sleep(5);
    second = withFileTransactionAsync(file, "second journal waiter", () => { order.push("second"); }, { waitMs: 2_000 });
    release.resolve();
    await Promise.all([holder, first, second]);
    expect(order).toEqual(["first", "second"]);
  } finally {
    release.resolve();
    await Promise.allSettled([holder, first, second]);
  }
});
