import { afterEach, describe, expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import { CPU_WAIT_MAX_ENTRIES, CPU_WAIT_MAX_TOTAL_BYTES, cpuWaitConfirmedElapsed, cpuInheritedWaitMs, cpuWaitBudget, cpuWaitElapsed, reportCpuWait } from "./cpuAdmissionBudget";
import { realExec } from "../workflows/provision";

test("bounded wait observations stop at their entry limit and retain interval union accounting", () => {
  const budget = cpuWaitBudget({ NODE_ENV: "test" });
  try {
    fs.writeFileSync(`${budget.directory}/one.json`, JSON.stringify({ start: 100, end: 300 }));
    fs.writeFileSync(`${budget.directory}/two.json`, JSON.stringify({ start: 200, end: 400 }));
    expect(cpuWaitElapsed(budget.directory, 500, 2)).toBe(300);
    expect(() => cpuWaitElapsed(budget.directory, 500, 1)).toThrow("observation bound");
    expect(cpuWaitElapsed(budget.directory, 500, 2)).toBe(300);
  } finally { budget.close(); }
});

test.each(["{", JSON.stringify({ start: 300, end: 200 })])("unknown wait accounting is rejected: %s", row => {
  const budget = cpuWaitBudget({ NODE_ENV: "test" });
  try {
    fs.writeFileSync(`${budget.directory}/unknown.json`, row);
    expect(() => cpuWaitElapsed(budget.directory, 500)).toThrow();
    expect(budget.elapsed()).toBe(0);
  } finally { budget.close(); }
});

test("unreadable wait accounting reports zero without escaping its owner", () => {
  const budget = cpuWaitBudget({ NODE_ENV: "test" });
  try {
    fs.rmSync(budget.directory, { recursive: true });
    expect(budget.elapsed()).toBe(0);
  } finally { budget.close(); }
});

test("oversized wait markers are rejected before their payload is read", () => {
  const budget = cpuWaitBudget({ NODE_ENV: "test" });
  const file = `${budget.directory}/large.json`;
  try {
    fs.writeFileSync(file, JSON.stringify({ start: 1, end: 2, padding: "x".repeat(128 * 1024) }));
    const read = spyOn(fs, "readSync");
    try {
      expect(() => cpuWaitElapsed(budget.directory, Date.now(), CPU_WAIT_MAX_ENTRIES, CPU_WAIT_MAX_TOTAL_BYTES)).toThrow("byte observation bound");
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  } finally { budget.close(); }
});

test("parallel waits count their union; ended waits still extend the next check", () => {
  const budget = cpuWaitBudget({ NODE_ENV: "test" });
  const dir = JSON.parse(budget.env.LLV_CPU_WAIT_ROOTS!)[0];
  try {
    fs.writeFileSync(`${dir}/one.json`, JSON.stringify({ start: 100, end: 300 }));
    fs.writeFileSync(`${dir}/two.json`, JSON.stringify({ start: 200, end: 400 }));
    fs.writeFileSync(`${dir}/three.json`, JSON.stringify({ start: 450, end: 500 }));
    expect(cpuWaitElapsed(dir, 500)).toBe(350);
    const nested = cpuWaitBudget(budget.env);
    try { expect(cpuInheritedWaitMs(nested.env)).toBe(0); }
    finally { nested.close(); }
    expect(cpuInheritedWaitMs(budget.env)).toBe(350);
  } finally { budget.close(); }
});

test("a caller's finite command timeout excludes gate waiting and still stops execution", async () => {
  const script = 'import { reportCpuWait } from "./src/lib/runtime/cpuAdmissionBudget"; const end = reportCpuWait(); await Bun.sleep(800); end(); await Bun.sleep(Number(process.argv[1]));';
  const pass = await realExec(process.execPath, ["-e", script, "30"], process.cwd(), undefined, { timeoutMs: 400 });
  expect(pass.code, pass.stderr).toBe(0);
  const fail = await realExec(process.execPath, ["-e", script, "800"], process.cwd(), undefined, { timeoutMs: 400 });
  expect(fail.code).toBeNull();
  expect(fail.stderr).toStartWith("command timed out after 400ms");
}, 10_000);

test("cancellation remains immediate during an excluded wait", async () => {
  const signal = new AbortController();
  const script = 'import { reportCpuWait } from "./src/lib/runtime/cpuAdmissionBudget"; reportCpuWait(); await Bun.sleep(10000);';
  const command = realExec(process.execPath, ["-e", script], process.cwd(), undefined, { signal: signal.signal, timeoutMs: 500 });
  await Bun.sleep(150); signal.abort();
  const result = await command;
  expect(result.code).toBeNull();
  expect(result.stderr).toStartWith("command cancelled");
}, 5_000);

test("corrupt wait accounting expires an owned command through cleanup instead of escaping its timer", async () => {
  const script = 'import fs from "node:fs"; import path from "node:path"; const root = JSON.parse(process.env.LLV_CPU_WAIT_ROOTS).at(-1); fs.writeFileSync(path.join(root, "corrupt.json"), "{"); await Bun.sleep(2000);';
  const result = await realExec(process.execPath, ["-e", script], process.cwd(), undefined, { timeoutMs: 300 });
  expect(result.code).toBeNull();
  expect(result.stderr).toStartWith("command timed out after 300ms");
}, 5_000);

test("execution allowance retains CPU wait credit beyond the watchdog observation limit", async () => {
  const script = `
    import { reportCpuWait } from "./src/lib/runtime/cpuAdmissionBudget";
    for (let index = 0; index < 256; index++) reportCpuWait()();
    const end = reportCpuWait();
    await Bun.sleep(800);
    end();
    await Bun.sleep(30);
  `;
  const result = await realExec(process.execPath, ["-e", script], process.cwd(), undefined, { timeoutMs: 400 });
  expect(result.code, result.stderr).toBe(0);
}, 5_000);

test("full execution credit has a bounded durable confirmation tied to its ledger incarnation", () => {
  const budget = cpuWaitBudget({ NODE_ENV: "test" });
  try {
    for (let index = 0; index < 257; index++) fs.writeFileSync(`${budget.directory}/${index}.json`, JSON.stringify({ start: 100, end: 100 }));
    fs.writeFileSync(`${budget.directory}/long.json`, JSON.stringify({ start: 100, end: 900 }));
    expect(cpuWaitElapsed(budget.directory, 1000)).toBe(800);
    expect(() => cpuWaitElapsed(budget.directory, 1000, CPU_WAIT_MAX_ENTRIES, CPU_WAIT_MAX_TOTAL_BYTES)).toThrow("observation bound");
    expect(cpuWaitConfirmedElapsed(budget.directory, 1000)).toBe(800);
    fs.renameSync(budget.directory, `${budget.directory}-old`);
    fs.mkdirSync(budget.directory);
    try { expect(() => cpuWaitConfirmedElapsed(budget.directory, 1000)).toThrow("invalid"); }
    finally { fs.rmSync(`${budget.directory}-old`, { recursive: true, force: true }); }
  } finally { budget.close(); }
});

test.each([["corrupt", "{"], ["missing fields", "{}"], ["negative credit", JSON.stringify({ elapsed: -1 })], ["oversized", "x".repeat(1025)]])(
  "invalid or oversized confirmations keep unknown accounting finite: %s", (_kind, contents) => {
    const budget = cpuWaitBudget({ NODE_ENV: "test" });
    try {
      fs.writeFileSync(`${budget.directory}.confirmed`, contents);
      expect(() => cpuWaitConfirmedElapsed(budget.directory)).toThrow();
    } finally { budget.close(); }
  },
);

test("the surviving executor confirms its publication ancestor beyond the observation bound", async () => {
  const budget = cpuWaitBudget({ NODE_ENV: "test" });
  try {
    const now = Date.now();
    for (let index = 0; index < 256; index++) fs.writeFileSync(`${budget.directory}/${index}.json`, JSON.stringify({ start: now - 720_000, end: now - 720_000 }));
    fs.writeFileSync(`${budget.directory}/long.json`, JSON.stringify({ start: now - 720_000, end: now }));
    const result = await realExec(process.execPath, ["-e", "await Bun.sleep(180)"], process.cwd(), {
      LLV_CPU_WAIT_CONFIRM_ROOT: budget.directory,
    }, { timeoutMs: 1000 });
    expect(result.code, result.stderr).toBe(0);
    expect(cpuWaitConfirmedElapsed(budget.directory)).toBe(720_000);
  } finally { budget.close(); }
});

/* Windows refuses to rename over a file another handle holds open (EPERM or
   EBUSY while a reader totals the ledger). A record replaced under such a
   reader failed the worker admission of the native Windows launcher test, so
   the rename is simulated here to refuse the way that platform does. */
describe("a heartbeat replaces its record while a reader holds it open", () => {
  const realRename = fs.renameSync.bind(fs);
  const refuse = (code: string, from: unknown, to: unknown) =>
    Object.assign(new Error(`${code}: operation not permitted, rename '${String(from)}' -> '${String(to)}'`), { code, syscall: "rename" });
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const on = (value: NodeJS.Platform) => Object.defineProperty(process, "platform", { ...platform, value });
  afterEach(() => Object.defineProperty(process, "platform", platform));

  /** Refuses the first `refusals` renames onto a ledger record, then lets the real one through. */
  const refusing = (code: string, refusals: number) => {
    const state = { refused: 0, calls: 0 };
    const spy = spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (!String(to).endsWith(".json")) return realRename(from, to);
      state.calls++;
      if (state.refused < refusals) { state.refused++; throw refuse(code, from, to); }
      return realRename(from, to);
    }) as typeof fs.renameSync);
    return { state, spy };
  };
  const records = (dir: string) => fs.readdirSync(dir).filter(name => name.endsWith(".json")).map(name => JSON.parse(fs.readFileSync(`${dir}/${name}`, "utf8")));

  test.each(["EPERM", "EBUSY"])("on Windows a %s on the opening and the closing write is retried until the record is replaced", code => {
    const budget = cpuWaitBudget({ NODE_ENV: "test" });
    const { state, spy } = refusing(code, 3);
    try {
      on("win32");
      const end = reportCpuWait(budget.env);
      expect(state.refused).toBe(3);
      expect(records(budget.directory)).toEqual([{ start: expect.any(Number), end: expect.any(Number), closed: false }]);
      state.refused = 0;
      end();
      expect(state.refused).toBe(3);
      const [record] = records(budget.directory);
      expect(record.closed).toBe(true);
      expect(record.end).toBeGreaterThanOrEqual(record.start);
      expect(fs.readdirSync(budget.directory).filter(name => name.endsWith(".next"))).toEqual([]);
      expect(Number.isFinite(cpuWaitElapsed(budget.directory))).toBe(true);
    } finally { spy.mockRestore(); budget.close(); }
  });

  test("a handle held past the bound still fails the heartbeat with the platform's error", () => {
    const budget = cpuWaitBudget({ NODE_ENV: "test" });
    const { state, spy } = refusing("EPERM", Number.POSITIVE_INFINITY);
    try {
      on("win32");
      expect(() => reportCpuWait(budget.env)).toThrow("EPERM");
      expect(state.calls).toBe(101);
    } finally { spy.mockRestore(); budget.close(); }
  });

  test("another error code is never retried", () => {
    const budget = cpuWaitBudget({ NODE_ENV: "test" });
    const { state, spy } = refusing("ENOSPC", Number.POSITIVE_INFINITY);
    try {
      on("win32");
      expect(() => reportCpuWait(budget.env)).toThrow("ENOSPC");
      expect(state.calls).toBe(1);
    } finally { spy.mockRestore(); budget.close(); }
  });

  test("off Windows an EPERM is a real permission fault and is not retried", () => {
    const budget = cpuWaitBudget({ NODE_ENV: "test" });
    const { state, spy } = refusing("EPERM", Number.POSITIVE_INFINITY);
    try {
      on("linux");
      expect(() => reportCpuWait(budget.env)).toThrow("EPERM");
      expect(state.calls).toBe(1);
    } finally { spy.mockRestore(); budget.close(); }
  });
});
