import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { ownFixtureTree, stopFixtureProcess } from "@/lib/testing/fixtureProcess";
import { processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import path from "node:path";
import * as timers from "node:timers/promises";
import { Database } from "bun:sqlite";
import { OperationLease, OperationLeaseExpiredError } from "@/lib/operationLease";
import { roleMemoryCollection, storedLessonRevision } from "./roleStore";
import { withoutStoredLessonsAsync, withCurrentRoleMemory, renderReportAsync, scrubIssueReportAsync, refreshCurationKnownValuesAsync, RoleMemoryChanged } from "./privacy";
import { PrivacyWorkError, privacyFailureOf } from "./privacyFailure";
import { PRIVACY_RETRY_WINDOW_MS, privacyWorkTimeoutMs } from "./privacyRetry";
import { TaskPageWorker, shutdownTaskPageWorker } from "@/lib/links/taskPageWorker";
import { sharedLinkState } from "@/lib/links/runtimeState";

const privateText = "Keep silver orchard evidence private until the owning operation completes";
let generation = 0;
const root = process.env.LLV_STATE_DIR!;
function store() {
  process.env.LLV_STATE_DIR = path.join(root, `retry-${++generation}`);
  roleMemoryCollection(true)!.boundedPatch(1, tx => tx.put({
    kind: "rule", id: "r_privacy_retry", scope: "machine", rule: privateText, why: "", state: "active", hints: [],
    source: { project: "fixture", pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_fixture" },
    createdAt: "2026-11-05T00:00:00Z", changedAt: "2026-11-05T00:00:00Z",
  }));
}
afterEach(async () => { await shutdownTaskPageWorker(); process.env.LLV_STATE_DIR = root; });

test("separate module copies share the caller cutoff and validate carried diagnostics", async () => {
  store();
  const directory = fs.mkdtempSync(path.join(process.env.TMPDIR!, "privacy-module-copy-"));
  fs.copyFileSync(path.join(import.meta.dir, "privacyFailure.ts"), path.join(directory, "privacyFailure.ts"));
  fs.writeFileSync(path.join(directory, "privacyRetry.ts"), fs.readFileSync(path.join(import.meta.dir, "privacyRetry.ts"), "utf8")
    .replace('"@/lib/operationLease"', JSON.stringify(path.join(import.meta.dir, "../operationLease.ts"))));
  const other = await import(path.join(directory, "privacyRetry.ts")) as typeof import("./privacyRetry");
  const diagnostics = await import(path.join(directory, "privacyFailure.ts")) as typeof import("./privacyFailure");
  let clock = 0, calls = 0;
  const now = spyOn(performance, "now").mockImplementation(() => clock);
  const pause = spyOn(timers, "setTimeout").mockImplementation(async <T = void>(ms: number | undefined, value?: T): Promise<T> => {
    clock += Number(ms);
    return value as T;
  });
  const log = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await withCurrentRoleMemory(async () => {
      clock = 179_000;
      return other.withPrivacyRetry(async () => other.privacyWorkTimeoutMs());
    })).toBe(1_000);
    clock = 0;
    expect(await withCurrentRoleMemory(async () => {
      if (++calls === 1) throw new diagnostics.PrivacyWorkError("store-busy");
      return withoutStoredLessonsAsync(privateText);
    })).toBe("[learned rule]");
    expect(calls).toBe(2);
    expect(privacyFailureOf({ cause: { failure: privateText } })).toBe("worker-unavailable");
  } finally { now.mockRestore(); pause.mockRestore(); log.mockRestore(); }
});

test.each(["SQLITE_BUSY", "ETIMEDOUT"])("nested privacy preparation recovers after two minutes: %s", async code => {
  store();
  let clock = 0, calls = 0, delivered = false;
  const now = spyOn(performance, "now").mockImplementation(() => clock);
  const pause = spyOn(timers, "setTimeout").mockImplementation(async <T = void>(ms: number | undefined, value?: T): Promise<T> => {
    expect(delivered).toBe(false);
    clock += Number(ms);
    return value as T;
  });
  const log = spyOn(console, "warn").mockImplementation(() => {});
  const real = TaskPageWorker.prototype.privacy;
  const worker = spyOn(TaskPageWorker.prototype, "privacy").mockImplementation(async function(this: TaskPageWorker, request) {
    if (++calls < 3) { clock += 60_000; throw Object.assign(new Error(privateText), { code }); }
    return real.call(this, request);
  });
  try {
    const result = await withCurrentRoleMemory(async () => ({ text: await withoutStoredLessonsAsync(privateText) }));
    delivered = true;
    expect(result).toEqual({ text: "[learned rule]" });
    expect(calls).toBe(3);
    expect(clock).toBe(123_000);
    expect(log.mock.calls.flat().join("\n")).toContain(code === "SQLITE_BUSY" ? "store-busy" : "worker-timeout");
    expect(log.mock.calls.flat().join("\n")).toContain("retrying before dispatch");
    expect(log.mock.calls.flat().join("\n")).not.toContain(privateText);
  } finally { worker.mockRestore(); log.mockRestore(); pause.mockRestore(); now.mockRestore(); }
});

test("a busy initial revision read retains its category and rechecks the store before filtering", async () => {
  store();
  let clock = 0, reads = 0;
  const now = spyOn(performance, "now").mockImplementation(() => clock);
  const pause = spyOn(timers, "setTimeout").mockImplementation(async <T = void>(ms: number | undefined, value?: T): Promise<T> => {
    clock += Number(ms);
    return value as T;
  });
  const log = spyOn(console, "warn").mockImplementation(() => {});
  const stat = fs.statSync;
  const read = spyOn(fs, "statSync").mockImplementation(new Proxy(stat, {
    apply(target, thisArg, args) {
      if (String(args[0]) === path.join(process.env.LLV_STATE_DIR!, "state.sqlite") && ++reads === 1) {
        throw Object.assign(new Error(privateText), { code: "SQLITE_BUSY" });
      }
      return Reflect.apply(target, thisArg, args);
    },
  }));
  try {
    expect(await withoutStoredLessonsAsync(privateText)).toBe("[learned rule]");
    expect(pause).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().join("\n")).toContain("store-busy");
    expect(log.mock.calls.flat().join("\n")).not.toContain(privateText);
  } finally { read.mockRestore(); log.mockRestore(); pause.mockRestore(); now.mockRestore(); }
});

test("a revision retry keeps the cause of the failed privacy pass in the log", async () => {
  store();
  let calls = 0;
  const log = spyOn(console, "warn").mockImplementation(() => {});
  const real = TaskPageWorker.prototype.privacy;
  const worker = spyOn(TaskPageWorker.prototype, "privacy").mockImplementation(async function(this: TaskPageWorker, request) {
    if (++calls === 1) {
      const held = roleMemoryCollection()!;
      const prior = held.get("r:r_privacy_retry")!;
      held.boundedPatch(1, tx => tx.put({ ...prior, changedAt: "2026-11-05T00:01:00Z" } as typeof prior));
      throw Object.assign(new Error(privateText), { code: "ETIMEDOUT" });
    }
    return real.call(this, request);
  });
  try {
    expect(await withoutStoredLessonsAsync(privateText)).toBe("[learned rule]");
    expect(calls).toBe(2);
    expect(log.mock.calls.flat().join("\n")).toContain("worker-timeout");
    expect(log.mock.calls.flat().join("\n")).not.toContain(privateText);
  } finally { worker.mockRestore(); log.mockRestore(); }
});

test("one cutoff bounds nested retries, caps worker time and rejects a late success", async () => {
  store();
  let clock = 0, calls = 0;
  const budgets: number[] = [];
  const now = spyOn(performance, "now").mockImplementation(() => clock);
  const pause = spyOn(timers, "setTimeout").mockImplementation(async <T = void>(ms: number | undefined, value?: T): Promise<T> => {
    clock += Number(ms);
    return value as T;
  });
  const log = spyOn(console, "warn").mockImplementation(() => {});
  const worker = spyOn(TaskPageWorker.prototype, "privacy").mockImplementation(async () => {
    calls++;
    if (calls > 4) throw new Error("fixture detected an unbounded retry");
    budgets.push(privacyWorkTimeoutMs());
    clock += privacyWorkTimeoutMs();
    throw new PrivacyWorkError("worker-timeout");
  });
  try {
    await expect(withCurrentRoleMemory(() => withoutStoredLessonsAsync(privateText))).rejects.toMatchObject({
      code: "LESSON_PRIVACY_UNAVAILABLE", message: expect.stringContaining("worker-timeout; retry window exhausted after 180 seconds"),
    });
    expect(clock).toBe(PRIVACY_RETRY_WINDOW_MS);
    expect(calls).toBe(3);
    expect(budgets).toEqual([60_000, 60_000, 57_000]);
    expect(log.mock.calls.flat().join("\n")).not.toContain(privateText);
    clock = 0;
    worker.mockImplementation(async () => { clock = PRIVACY_RETRY_WINDOW_MS; return { privacyRevision: storedLessonRevision(), value: "late unchecked value" }; });
    await expect(withoutStoredLessonsAsync(privateText)).rejects.toMatchObject({ code: "LESSON_PRIVACY_UNAVAILABLE" });
  } finally { worker.mockRestore(); log.mockRestore(); pause.mockRestore(); now.mockRestore(); }
});

test("a restarted process safely starts a fresh preparation window", async () => {
  store();
  const directory = process.env.LLV_STATE_DIR!;
  for (const mode of ["interrupted", "exhausted"]) {
    const child = Bun.spawn([process.execPath, "test", import.meta.path, "-t", "^restart privacy preparation child$"], {
      env: { ...process.env, LLV_PRIVACY_RESTART_STATE: directory, LLV_PRIVACY_RESTART_MODE: mode },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, out + err).toBe(0);
    expect(err).toContain("1 pass");
  }
});

test.skipIf(!process.env.LLV_PRIVACY_RESTART_STATE)("restart privacy preparation child", async () => {
  process.env.LLV_STATE_DIR = process.env.LLV_PRIVACY_RESTART_STATE!;
  const lease = new OperationLease();
  let clock = 0, calls = 0;
  const now = spyOn(performance, "now").mockImplementation(() => clock);
  const pause = spyOn(timers, "setTimeout").mockImplementation(async <T = void>(ms: number | undefined, value?: T): Promise<T> => {
    if (process.env.LLV_PRIVACY_RESTART_MODE === "interrupted") lease.expire();
    clock += Number(ms);
    return value as T;
  });
  const log = spyOn(console, "warn").mockImplementation(() => {});
  const worker = spyOn(TaskPageWorker.prototype, "privacy").mockImplementation(async () => {
    calls++;
    clock += privacyWorkTimeoutMs();
    throw new PrivacyWorkError("worker-timeout");
  });
  try {
    const result = lease.run(() => withoutStoredLessonsAsync(privateText));
    if (process.env.LLV_PRIVACY_RESTART_MODE === "interrupted") {
      await expect(result).rejects.toBeInstanceOf(OperationLeaseExpiredError);
      expect(calls).toBe(1);
    } else {
      await expect(result).rejects.toMatchObject({ code: "LESSON_PRIVACY_UNAVAILABLE", message: expect.stringContaining("retry window exhausted") });
      expect(calls).toBe(3);
      expect(clock).toBe(180_000);
    }
    expect(roleMemoryCollection()!.get("r:r_privacy_retry")).toMatchObject({ rule: privateText });
  } finally { worker.mockRestore(); log.mockRestore(); pause.mockRestore(); now.mockRestore(); }
});

test.each(["filter", "report", "issue", "curation"])("permanent errors stay decisive and secret-free: %s", async kind => {
  store();
  const pause = spyOn(timers, "setTimeout").mockImplementation(async <T = void>(): Promise<T> => { throw new Error("permanent failure was retried"); });
  const log = spyOn(console, "warn").mockImplementation(() => {});
  const worker = spyOn(TaskPageWorker.prototype, "privacy").mockRejectedValue(Object.assign(new Error(privateText), { code: "EACCES" }));
  const deny = { accounts: [], people: [], local: [], projects: [] };
  try {
    const call = kind === "filter" ? () => withoutStoredLessonsAsync(privateText)
      : kind === "report" ? () => renderReportAsync({ class: "status", name: "Delegatus", at: new Date("2026-11-05T00:00:00Z"), locale: "en", timeZone: "UTC", summary: privateText, sections: {}, deny })
      : kind === "issue" ? () => scrubIssueReportAsync({ title: privateText, body: privateText }, deny) : refreshCurationKnownValuesAsync;
    const error = await call().catch(error => error);
    expect(error).toMatchObject({ code: "LESSON_PRIVACY_UNAVAILABLE", message: expect.stringContaining("access-denied") });
    expect(String(error)).not.toContain(privateText);
    expect(log.mock.calls.flat().join("\n")).toContain("access-denied");
    expect(log.mock.calls.flat().join("\n")).toContain("refusing; nothing was sent");
    expect(log.mock.calls.flat().join("\n")).not.toContain(privateText);
    expect(worker).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
  } finally { worker.mockRestore(); log.mockRestore(); pause.mockRestore(); }
});

test("lease revocation during backoff prevents another read or result", async () => {
  store();
  const lease = new OperationLease();
  const pause = spyOn(timers, "setTimeout").mockImplementation(async <T = void>(ms: number | undefined, value?: T): Promise<T> => {
    lease.expire();
    return value as T;
  });
  const log = spyOn(console, "warn").mockImplementation(() => {});
  const worker = spyOn(TaskPageWorker.prototype, "privacy").mockRejectedValue(new PrivacyWorkError("store-busy"));
  try {
    await expect(lease.run(() => withoutStoredLessonsAsync(privateText))).rejects.toBeInstanceOf(OperationLeaseExpiredError);
    expect(worker).toHaveBeenCalledTimes(1);
  } finally { worker.mockRestore(); log.mockRestore(); pause.mockRestore(); }
});

test.each(["store-busy", privateText])("worker error frames retain only allowlisted diagnostics: %s", async failure => {
  store();
  const fixture = path.join(process.env.TMPDIR!, `failure-worker-${generation}.ts`);
  fs.writeFileSync(fixture, `import readline from "node:readline";
for await (const line of readline.createInterface({input:process.stdin})) {
 const {id}=JSON.parse(line); process.stdout.write(JSON.stringify({id,error:"LESSON_PRIVACY_UNAVAILABLE",failure:${JSON.stringify(failure)}})+"\\n");
}`);
  const worker = new TaskPageWorker({ launch: { executable: process.execPath, workerPath: fixture } });
  try {
    const error = await worker.privacy({ kind: "filter", value: privateText }).catch(error => error);
    expect(privacyFailureOf(error)).toBe(failure === privateText ? "worker-unavailable" : "store-busy");
    expect(String(error)).not.toContain(privateText);
  } finally { await worker.shutdown(); }
});

test("the real worker carries a corrupt stored row's category without the row", async () => {
  store();
  const database = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
  database.query("UPDATE state_rows SET value_json = ? WHERE collection = 'role_memory' AND row_key = 'r:r_privacy_retry'")
    .run(JSON.stringify({ kind: "rule", id: 7, rule: privateText }));
  database.close();
  const log = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const error = await withoutStoredLessonsAsync(privateText).catch(error => error);
    expect(error).toMatchObject({ code: "LESSON_PRIVACY_UNAVAILABLE", message: expect.stringContaining("store-corrupt") });
    expect(String(error)).not.toContain(privateText);
    expect(log.mock.calls.flat().join("\n")).toContain("store-corrupt");
    expect(log.mock.calls.flat().join("\n")).not.toContain(privateText);
  } finally { log.mockRestore(); }
});

// This supervisor uses wall time in a different process. Neither the worker
// method nor performance.now is mocked: removing the submit timer's cap must
// leave the child running past this watchdog, and fail the parent.
test("real worker deadline is independently supervised and cleans up its processes", async () => {
  const directory = fs.mkdtempSync(path.join(process.env.TMPDIR!, "privacy-deadline-"));
  const identities = path.join(directory, "workers.jsonl");
  const child = ownFixtureTree(spawn(process.execPath, ["test", "--timeout=220000", import.meta.path, "-t", "^real worker deadline child$"], {
    env: { ...process.env, LLV_PRIVACY_DEADLINE_CHILD: directory, LLV_STATE_DIR: path.join(directory, "state") },
    stdio: ["ignore", "pipe", "pipe"],
  }));
  let output = "", timedOut = false;
  child.stdout!.on("data", chunk => { output += chunk; });
  child.stderr!.on("data", chunk => { output += chunk; });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve); child.once("error", reject);
  });
  let cleanup: Promise<void> | undefined;
  const watchdog = setTimeout(() => {
    timedOut = true;
    cleanup = stopFixtureProcess(child);
  }, PRIVACY_RETRY_WINDOW_MS + 15_000);
  try {
    const exit = await closed;
    await cleanup;
    expect(timedOut, output).toBe(false);
    expect(exit, output).toBe(0);
    expect(output).toContain("worker-timeout; retry window exhausted after 180 seconds");
    expect(output).toContain('"dispatches":0');
    expect(output).not.toContain(privateText);
  } finally {
    clearTimeout(watchdog);
    await stopFixtureProcess(child);
    await cleanup;
    const workers = fs.existsSync(identities) ? fs.readFileSync(identities, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as ProcessIdentity) : [];
    expect(workers.length).toBeGreaterThan(0);
    for (const identity of workers) expect(processIdentityStatus(identity)).toBe("dead");
  }
}, 220_000);

test.skipIf(!process.env.LLV_PRIVACY_DEADLINE_CHILD)("real worker deadline child", async () => {
  store();
  const directory = process.env.LLV_PRIVACY_DEADLINE_CHILD!;
  const fixture = path.join(directory, "blocked-worker.ts");
  // The leased helper is a real subprocess that remains blocked until its
  // owner closes the lease. Record its launch identity for the supervisor.
  fs.writeFileSync(fixture, `import fs from "node:fs";
import { captureProcessIdentity } from ${JSON.stringify(path.join(import.meta.dir, "../processIdentity.ts"))};
fs.appendFileSync(${JSON.stringify(path.join(directory, "workers.jsonl"))}, JSON.stringify(captureProcessIdentity(process.pid)) + "\\n");
setInterval(() => {}, 1000);
`);
  const worker = new TaskPageWorker({ launch: { executable: process.execPath, workerPath: fixture } });
  const pool = sharedLinkState("taskPages.worker", () => ({ directory: "", worker: null as TaskPageWorker | null }));
  pool.directory = process.env.LLV_STATE_DIR!;
  pool.worker = worker;
  let dispatches = 0, calls = 0;
  const started = performance.now();
  try {
    const result = withCurrentRoleMemory(async () => {
      // Spend real preparation time before the first worker request. The last
      // request then has much less than 60 seconds left (about 27 seconds),
      // giving the independent watchdog ample room to detect a removed cap.
      if (++calls === 1) await timers.setTimeout(30_000);
      return withoutStoredLessonsAsync(privateText);
    }).then(value => { dispatches++; return value; });
    const error = await result.catch(error => error);
    const reason = String(error.message);
    console.info(JSON.stringify({ reason, dispatches }));
    expect(error.code).toBe("LESSON_PRIVACY_UNAVAILABLE");
    expect(reason).toContain("worker-timeout; retry window exhausted after 180 seconds");
    expect(reason).toContain("during privacy worker request; privacy worker requests 3");
    expect(performance.now() - started).toBeGreaterThanOrEqual(PRIVACY_RETRY_WINDOW_MS);
    expect(dispatches).toBe(0);
    expect(calls).toBe(3);
  } finally { await worker.shutdown(); }
}, 220_000);


test.each(["worker", "composition", "backoff", "real-timeouts"] as const)("exhaustion reports safe phase and the genuine preceding cause: %s", async mode => {
  store();
  let clock = 0, calls = 0;
  const now = spyOn(performance, "now").mockImplementation(() => clock);
  const pause = spyOn(timers, "setTimeout").mockImplementation(async <T = void>(ms: number | undefined, value?: T): Promise<T> => {
    clock += Number(ms);
    return value as T;
  });
  const log = spyOn(console, "warn").mockImplementation(() => {});
  const worker = spyOn(TaskPageWorker.prototype, "privacy").mockImplementation(async () => {
    calls++;
    clock += privacyWorkTimeoutMs();
    throw new PrivacyWorkError("worker-timeout");
  });
  try {
    const error = await withCurrentRoleMemory(async () => {
      if (mode === "composition") { clock = 180_000; return "late"; }
      if (mode === "backoff") { clock = 179_500; throw new PrivacyWorkError("store-busy"); }
      if (mode === "worker") clock = 170_000;
      return withoutStoredLessonsAsync(privateText);
    }).catch(error => error);
    const cause = mode === "real-timeouts" ? "worker-timeout" : mode === "backoff" ? "store-busy" : "window-exhausted";
    const phase = mode === "worker" || mode === "real-timeouts" ? "privacy worker request" : mode;
    const message = error.message;
    expect(error.code).toBe("LESSON_PRIVACY_UNAVAILABLE");
    expect(message).toContain(`${cause}; retry window exhausted after 180 seconds during ${phase}`);
    expect(message).toContain(`privacy worker requests ${calls}`);
    expect(clock).toBe(180_000);
    if (mode === "worker") {
      expect(calls).toBe(1);
      expect(message).toContain("(10.0 s), composition 170.0 s");
      expect(log.mock.calls.flat().join("\n")).not.toContain("worker-timeout");
    }
    if (mode === "real-timeouts") expect(calls).toBe(3);
    expect(log.mock.calls.flat().join("\n")).not.toContain(privateText);
  } finally { worker.mockRestore(); log.mockRestore(); pause.mockRestore(); now.mockRestore(); }
});

test("revision churn preserves the caller deferral without sleeping or parking", async () => {
  store();
  const collection = roleMemoryCollection()!;
  let calls = 0;
  const pause = spyOn(timers, "setTimeout").mockImplementation(async () => { throw Error("revision deferral was retried"); });
  const log = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(withCurrentRoleMemory(async () => {
      const rule = collection.get("r:r_privacy_retry")!;
      if (rule.kind !== "rule") throw Error("rule missing");
      collection.boundedPatch(1, tx => tx.put({ ...rule, changedAt: `2026-11-06T00:00:0${++calls}Z` }));
      return "unapproved";
    })).rejects.toBeInstanceOf(RoleMemoryChanged);
    expect(calls).toBe(3);
    expect(pause).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join("\n")).toContain("store-changed; deferring to the caller");
    expect(log.mock.calls.flat().join("\n")).not.toContain("worker-unavailable");
  } finally { pause.mockRestore(); log.mockRestore(); }
});

test.each(["deferral", "exhaustion"] as const)("lease revocation remains decisive on the %s refusal path", async mode => {
  store();
  const lease = new OperationLease();
  let clock = 0;
  const now = spyOn(performance, "now").mockImplementation(() => clock);
  try {
    await expect(lease.run(() => withCurrentRoleMemory(async () => {
      lease.expire();
      if (mode === "deferral") throw new RoleMemoryChanged();
      clock = 180_000;
      throw new PrivacyWorkError("store-busy");
    }))).rejects.toBeInstanceOf(OperationLeaseExpiredError);
  } finally { now.mockRestore(); }
});
