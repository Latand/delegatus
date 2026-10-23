import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CpuAdmissionQueue } from "../src/lib/runtime/cpuAdmission";
import { admissionLockWait } from "./cpu-admission-lock";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "admission-lock-"));
  const file = path.join(dir, "admission.sqlite");
  const open = () => new CpuAdmissionQueue(file, Date.now, 0, undefined, undefined, undefined, 0);
  open().close();
  const writer = new Database(file);
  return { dir, open, writer, close() { writer.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function clock() {
  let now = 0;
  const sleeps: number[] = [];
  return { now: () => now, advance: (ms: number) => { now += ms; }, sleeps,
    sleep: async (ms: number) => { sleeps.push(ms); now += ms; } };
}
const locked = (code = "SQLITE_BUSY") => Object.assign(new Error("database is locked"), { code });

async function readOutput(stream: ReadableStream<Uint8Array>, receive: (text: string) => void) {
  const reader = stream.getReader(), decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      receive(decoder.decode(value, { stream: true }));
    }
    receive(decoder.decode());
  } finally { reader.releaseLock(); }
}

test("an uncontended operation returns without waiting or logging", async () => {
  const time = clock(), lines: string[] = [];
  expect(await admissionLockWait(120, line => lines.push(line), time)(() => "ready")).toBe("ready");
  expect(time.sleeps).toEqual([]);
  expect(lines).toEqual([]);
});

for (const code of ["SQLITE_BUSY", "SQLITE_LOCKED"]) {
  test(`${code} yields with bounded backoff and fails at one deadline`, async () => {
    const time = clock(), lines: string[] = [];
    let attempts = 0;
    await expect(admissionLockWait(120, line => lines.push(line), time)(() => { attempts++; throw locked(code); }))
      .rejects.toThrow("CPU admission queue lock deadline exceeded after 120 ms; checks did not start");
    expect(time.sleeps).toEqual([20, 40, 60]);
    expect(time.now()).toBe(120);
    expect(attempts).toBe(3);
    expect(lines).toEqual(["gate-slot: waiting for CPU admission queue SQLite lock (deadline 120 ms)"]);
  });
}

test("the default lock budget is 30 seconds and backoff caps at 250 ms", async () => {
  const time = clock();
  await expect(admissionLockWait(undefined, () => {}, time)(() => { throw locked(); }))
    .rejects.toThrow("deadline exceeded after 30000 ms");
  expect(time.now()).toBe(30_000);
  expect(Math.max(...time.sleeps)).toBe(250);
  expect(time.sleeps.every(ms => ms > 0)).toBe(true);
});

test("opening and later checks retain the first contention deadline", async () => {
  const time = clock(), lines: string[] = [];
  const retry = admissionLockWait(120, line => lines.push(line), time);
  let attempts = 0;
  expect(await retry(() => { if (attempts++ === 0) throw locked(); return "opened"; })).toBe("opened");
  expect(lines[1]).toBe("gate-slot: CPU admission queue lock acquired after 20 ms");
  time.advance(80);
  await expect(retry(() => { throw locked(); })).rejects.toThrow("deadline exceeded after 120 ms");
  expect(time.sleeps).toEqual([20, 20]);
  expect(time.now()).toBe(120);
  expect(lines.filter(line => line.includes("lock acquired"))).toHaveLength(1);
});

for (const error of [new Error("invalid schema"), null]) {
  test(`non-lock failure ${String(error)} is returned without retry`, async () => {
    const time = clock();
    let attempts = 0, caught: unknown = "not caught";
    try { await admissionLockWait(100, () => {}, time)(() => { attempts++; throw error; }); }
    catch (failure) { caught = failure; }
    expect(caught).toBe(error);
    expect(attempts).toBe(1);
    expect(time.sleeps).toEqual([]);
  });
}

for (const timeout of [0, -1, NaN, Infinity]) {
  test(`invalid timeout ${timeout} is refused`, () => {
    expect(() => admissionLockWait(timeout)).toThrow("must be a positive number");
  });
}

test("a real writer blocking opening and checking releases on an event-loop turn", async () => {
  const f = fixture(), lines: string[] = [];
  let queue: CpuAdmissionQueue | undefined, release: ReturnType<typeof setTimeout> | undefined;
  let released = false;
  const retry = admissionLockWait(5000, line => {
    lines.push(line);
    if (line.includes("waiting for")) release = setTimeout(() => { f.writer.exec("COMMIT"); released = true; }, 0);
  });
  try {
    f.writer.exec("BEGIN IMMEDIATE");
    queue = await retry(f.open);
    expect(released).toBe(true);
    expect(queue.check("command:test", false)).not.toBeNull();
    released = false;
    f.writer.exec("BEGIN IMMEDIATE");
    expect(await retry(() => queue!.check("command:test", true))).toBeNull();
    expect(released).toBe(true);
    expect(lines.filter(line => line.includes("waiting for"))).toHaveLength(2);
    expect(lines.filter(line => line.includes("lock acquired after"))).toHaveLength(2);
    expect(f.writer.query("SELECT * FROM tickets").all()).toHaveLength(0);
    expect(f.writer.query<{ last: number | null }, []>("SELECT last FROM admission").get()!.last).not.toBeNull();
  } finally { clearTimeout(release); queue?.close(); f.close(); }
});

for (const mode of ["--wait", "--claim"]) {
  test.skipIf(process.platform !== "linux")(`${mode} cancels during opening lock contention after a signal`, async () => {
    const f = fixture();
    f.writer.exec("BEGIN IMMEDIATE");
    const child = Bun.spawn([process.execPath, "scripts/cpu-admission.ts", mode, "command:cancelled", String(process.pid)], {
      env: { ...process.env, LLV_GATE_LOCK_DIR: f.dir, LLV_CPU_ADMISSION_LOCK_TIMEOUT_MS: "30000", DELEGATUS_CPU_PRESSURE: "off" }, stdout: "ignore", stderr: "pipe",
    });
    let stderr = "", triggered = false;
    const output = readOutput(child.stderr, chunk => {
      stderr += chunk;
      if (!triggered && stderr.includes("waiting for CPU admission queue SQLite lock")) {
        triggered = true;
        child.kill("SIGTERM");
      }
    });
    try {
      const code = await child.exited;
      await output;
      expect(triggered, stderr).toBe(true);
      expect(code, stderr).toBe(130);
      expect(stderr).not.toContain("lock acquired");
      expect(f.writer.query("SELECT * FROM tickets").all()).toHaveLength(0);
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
      await output;
      f.writer.exec("ROLLBACK"); f.close();
    }
  }, 5000);

  test.skipIf(process.platform !== "linux")(`${mode} ends its opening lock wait when its real parent exits`, async () => {
    const f = fixture();
    f.writer.exec("BEGIN IMMEDIATE");
    const script = `const child = Bun.spawn([process.execPath, "scripts/cpu-admission.ts", ${JSON.stringify(mode)}, "command:orphan", String(process.pid)], {
      stdin: "ignore", stdout: "ignore", stderr: "inherit"
    }); process.exit(await child.exited);`;
    const owner = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, LLV_GATE_LOCK_DIR: f.dir, LLV_CPU_ADMISSION_LOCK_TIMEOUT_MS: "30000", DELEGATUS_CPU_PRESSURE: "off" }, stdout: "ignore", stderr: "pipe",
    });
    let stderr = "", triggered = false;
    // EOF is the helper's exit acknowledgement: it inherited the pipe and
    // keeps it open after its parent exits until its own cancellation ends.
    const output = readOutput(owner.stderr, chunk => {
      stderr += chunk;
      if (!triggered && stderr.includes("waiting for CPU admission queue SQLite lock")) {
        triggered = true;
        owner.kill("SIGTERM");
      }
    });
    try {
      await owner.exited;
      await output;
      expect(triggered, stderr).toBe(true);
      expect(stderr.trim()).toBe("gate-slot: waiting for CPU admission queue SQLite lock (deadline 30000 ms)");
      expect(stderr).not.toContain("lock acquired");
      expect(stderr).not.toContain("deadline exceeded");
      expect(f.writer.query("SELECT * FROM tickets").all()).toHaveLength(0);
    } finally {
      if (owner.exitCode === null) owner.kill();
      await owner.exited;
      await output;
      f.writer.exec("ROLLBACK"); f.close();
    }
  }, 5000);

  test(`${mode} recovers from a held writer before its deadline`, async () => {
    const f = fixture();
    f.writer.exec("BEGIN IMMEDIATE");
    let held = true;
    try {
      const child = Bun.spawn([process.execPath, "scripts/cpu-admission.ts", mode, "command:recovery", String(process.pid)], {
        env: { ...process.env, LLV_GATE_LOCK_DIR: f.dir, LLV_CPU_ADMISSION_LOCK_TIMEOUT_MS: "5000", DELEGATUS_CPU_PRESSURE: "off" },
        stdout: "ignore", stderr: "pipe",
      });
      let stderr = "";
      const output = readOutput(child.stderr, chunk => {
        stderr += chunk;
        if (held && stderr.includes("waiting for CPU admission queue SQLite lock")) {
          f.writer.exec("COMMIT"); held = false;
        }
      });
      const code = await child.exited;
      await output;
      expect(code, stderr).toBe(0);
      expect(held).toBe(false);
      expect(stderr).toContain("lock acquired after");
      expect(f.writer.query("SELECT * FROM tickets").all()).toHaveLength(mode === "--wait" ? 1 : 0);
    } finally { if (held) f.writer.exec("ROLLBACK"); f.close(); }
  });

  test(`${mode} restarts with its own deadline after a held writer refusal`, async () => {
    const f = fixture();
    f.writer.exec("BEGIN IMMEDIATE");
    try {
      for (let invocation = 0; invocation < 2; invocation++) {
        const child = Bun.spawn([process.execPath, "scripts/cpu-admission.ts", mode, "command:locked", String(process.pid)], {
          env: { ...process.env, LLV_GATE_LOCK_DIR: f.dir, LLV_CPU_ADMISSION_LOCK_TIMEOUT_MS: "120", DELEGATUS_CPU_PRESSURE: "off" },
          stdout: "ignore", stderr: "pipe",
        });
        const output = new Response(child.stderr).text();
        const code = await child.exited;
        const stderr = await output;
        expect(code, stderr).toBe(1);
        expect(stderr).toContain("waiting for CPU admission queue SQLite lock");
        expect(stderr).toContain("lock deadline exceeded after 120 ms");
        expect(stderr).not.toContain("lock acquired");
        expect(f.writer.query("SELECT * FROM tickets").all()).toHaveLength(0);
      }
    } finally { f.writer.exec("ROLLBACK"); f.close(); }
  });
}
