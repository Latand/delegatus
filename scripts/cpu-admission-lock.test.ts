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

test("the runtime image's copied gate helper loads and refuses an absent slot lease", async () => {
  const root = path.resolve(import.meta.dir, "..");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "admission-runtime-"));
  try {
    const runtime = fs.readFileSync(path.join(root, "Dockerfile"), "utf8")
      .split(/^FROM runtime-system AS runtime$/m)[1].split(/^FROM /m)[0];
    const gateCopy = runtime.split("\n").find(line => line.startsWith("COPY --from=build ") && line.includes("/app/scripts/cpu-admission.ts "))!;
    expect(gateCopy).toBeDefined();
    const sources = gateCopy.split(/\s+/).slice(2, -1);
    const destination = gateCopy.split(/\s+/).at(-1)!;
    fs.mkdirSync(path.join(dir, destination), { recursive: true });
    for (const source of sources) {
      fs.copyFileSync(path.join(root, source.slice("/app/".length)), path.join(dir, destination, path.basename(source)));
    }
    // These are the source tree, aliases and dependencies shipped beside the
    // helper. No other scripts may leak in from the developer checkout.
    for (const name of ["src", "bin", "tsconfig.json"]) {
      expect(runtime).toContain(`COPY --from=build /app/${name} ./${name}`);
      fs.cpSync(path.join(root, name), path.join(dir, name), { recursive: true });
    }
    expect(runtime).toContain("COPY --from=build /app/node_modules ./node_modules");
    fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir");
    const child = Bun.spawn([process.execPath, "scripts/cpu-admission.ts", "--reuse-slot"], {
      cwd: dir, env: { ...process.env, LLV_GATE_SLOT_LEASE: "", LLV_GATE_LOCK_DIR: dir }, stdout: "pipe", stderr: "pipe",
    });
    const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      expect(await child.exited, await stderr).toBe(75);
      expect(await stdout).toBe("");
      expect(await stderr).toBe("");
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      await Promise.all([stdout, stderr]);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 15_000);

test("the helper retains its opening deadline through a second real writer contention", async () => {
  const f = fixture();
  // Keep the helper queued after opening, including on systems without flock.
  const ahead = f.open();
  try { ahead.check("stage:ahead", false, undefined, false); }
  finally { ahead.close(); }
  // Only time and sleep are controlled. The entry point, retry closure and
  // SQLite calls are real; this process owns an independent writer connection.
  const preload = path.join(f.dir, "clock.ts");
  fs.writeFileSync(preload, `
    let now = 0, resume;
    Object.defineProperty(performance, "now", { value: () => now });
    process.on("message", value => { now = value; const next = resume; resume = undefined; next(); });
    process.channel?.unref();
    Bun.sleep = ms => new Promise(resolve => { resume = resolve; process.send({ sleep: ms, now }); });
  `);
  f.writer.exec("BEGIN IMMEDIATE");
  let held = true, expired = false;
  const episodes: { sleep: number; now: number }[] = [];
  const child = Bun.spawn([process.execPath, "--preload", preload, "scripts/cpu-admission.ts", "--wait", "command:two-locks", String(process.pid)], {
    env: { ...process.env, LLV_GATE_LOCK_DIR: f.dir, LLV_CPU_ADMISSION_LOCK_TIMEOUT_MS: "120",
      DELEGATUS_CPU_PRESSURE: "off", LLV_GATE_CPU_PRIORITY_SOURCE: "", LLV_GATE_POLL_SECONDS: "0.123" },
    stdout: "ignore", stderr: "pipe",
    ipc(message, subprocess) {
      episodes.push(message);
      if (episodes.length === 1) {
        f.writer.exec("COMMIT"); held = false;
        subprocess.send(80); // Opening recovers after consuming 80 of 120 ms.
      } else if (episodes.length === 2) {
        f.writer.exec("BEGIN IMMEDIATE"); held = true;
        subprocess.send(100); // The first check completed; block the next one.
      } else if (episodes.length === 3) {
        subprocess.send(120); // Original deadline, before any fresh budget.
      } else {
        // A reset deadline would retry the still-held writer again.
        subprocess.kill("SIGKILL");
      }
    },
  });
  const output = new Response(child.stderr).text();
  const watchdog = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 5000);
  try {
    const code = await child.exited, stderr = await output;
    expect(expired, stderr).toBe(false);
    expect(episodes).toEqual([{ sleep: 20, now: 0 }, { sleep: 123, now: 80 }, { sleep: 20, now: 100 }]);
    expect(code, stderr).toBe(1);
    expect(stderr.match(/waiting for CPU admission queue SQLite lock/g)).toHaveLength(2);
    expect(stderr.match(/lock acquired after/g)).toHaveLength(1);
    expect(stderr).toContain("lock acquired after 80 ms");
    expect(stderr).toContain("lock deadline exceeded after 120 ms");
    expect(f.writer.query("SELECT key FROM tickets ORDER BY seq").all()).toEqual([{ key: "stage:ahead" }, { key: "command:two-locks" }]);
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await output;
    if (held) f.writer.exec("ROLLBACK");
    f.close();
  }
}, 15_000);

test("an uncontended operation returns without waiting or logging", async () => {
  const time = clock(), lines: string[] = [];
  expect(await admissionLockWait(120, line => lines.push(line), time)(() => "ready")).toBe("ready");
  expect(time.sleeps).toEqual([]);
  expect(lines).toEqual([]);
});

for (const code of ["SQLITE_BUSY", "SQLITE_LOCKED"]) {
  test(`an awaited ${code} is retried within the original bound`, async () => {
    const time = clock(), lines: string[] = [];
    let attempts = 0;
    const result = await admissionLockWait(120, line => lines.push(line), time)(async () => {
      await Promise.resolve();
      if (++attempts === 1) throw locked(code);
      return "ready";
    });
    expect(result).toBe("ready");
    expect(attempts).toBe(2);
    expect(time.sleeps).toEqual([20]);
    expect(lines.at(-1)).toBe("gate-slot: CPU admission queue lock acquired after 20 ms");
  });

  test(`an awaited ${code} cannot extend the lock deadline`, async () => {
    const time = clock();
    let attempts = 0;
    await expect(admissionLockWait(120, () => {}, time)(async () => {
      await Promise.resolve();
      attempts++;
      throw locked(code);
    })).rejects.toThrow("deadline exceeded after 120 ms");
    expect(attempts).toBe(3);
    expect(time.sleeps).toEqual([20, 40, 60]);
  });
}

for (const mode of ["--wait", "--claim"]) for (const highOnRetry of [false, true]) {
  test(`${mode} resamples pressure after SQLITE_BUSY (high on retry: ${highOnRetry})`, async () => {
    const f = fixture(), preload = path.join(f.dir, "pressure-retry.ts"), psi = path.join(f.dir, "pressure");
    // The real async pressure reader and real queue run in another process.
    // Handshakes place a writer after opening and change PSI before retrying.
    fs.writeFileSync(preload, `
      import { GateCpuPressure } from ${JSON.stringify(path.resolve("src/lib/runtime/gateCpuPressure.ts"))};
      import { CpuAdmissionQueue } from ${JSON.stringify(path.resolve("src/lib/runtime/cpuAdmission.ts"))};
      let resume, attempt = 0;
      process.on("message", () => { const next = resume; resume = undefined; next(); });
      process.channel?.unref();
      const barrier = value => new Promise(resolve => { resume = resolve; process.send(value); });
      const sample = GateCpuPressure.prototype.check;
      GateCpuPressure.prototype.check = async function() {
        await barrier({ kind: "sample", attempt: ++attempt });
        return sample.call(this);
      };
      const check = CpuAdmissionQueue.prototype.check;
      CpuAdmissionQueue.prototype.check = function(...args) {
        const wait = check.apply(this, args);
        process.send({ kind: "checked", waiting: wait !== null });
        return wait;
      };
      Bun.sleep = ms => barrier({ kind: "sleep", ms });
    `);
    const samples: number[] = [], checks: boolean[] = [], sleeps: number[] = [];
    let held = false, expired = false;
    const child = Bun.spawn([process.execPath, "--preload", preload, "scripts/cpu-admission.ts", mode, "command:pressure-retry", String(process.pid)], {
      env: { ...process.env, LLV_GATE_LOCK_DIR: f.dir, LLV_GATE_PSI_FILE: psi, DELEGATUS_CPU_PRESSURE: "on",
        DELEGATUS_CPU_PRESSURE_HOLD: "30", DELEGATUS_CPU_PRESSURE_RELEASE: "20", LLV_GATE_CPU_PRIORITY_SOURCE: "",
        LLV_GATE_PSI_RELEASE_SECONDS: "0", LLV_CPU_ADMISSION_LOCK_TIMEOUT_MS: "5000", LLV_GATE_POLL_SECONDS: "0.123" },
      stdout: "ignore", stderr: "pipe",
      ipc(message, subprocess) {
        if (message.kind === "sample") {
          samples.push(message.attempt);
          fs.writeFileSync(psi, `some avg10=${highOnRetry && message.attempt === 2 ? 90 : 0}.00\n`);
          if (message.attempt === 1) { f.writer.exec("BEGIN IMMEDIATE"); held = true; }
          subprocess.send("sample");
        } else if (message.kind === "sleep") {
          sleeps.push(message.ms);
          if (held) { f.writer.exec("COMMIT"); held = false; }
          subprocess.send("retry");
        } else if (message.kind === "checked") checks.push(message.waiting);
      },
    });
    const output = new Response(child.stderr).text();
    const watchdog = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 5000);
    try {
      const code = await child.exited, stderr = await output;
      expect(expired, stderr).toBe(false);
      expect(code, stderr).toBe(mode === "--claim" && highOnRetry ? 75 : 0);
      expect(samples).toEqual(mode === "--wait" && highOnRetry ? [1, 2, 3] : [1, 2]);
      expect(checks).toEqual(highOnRetry ? mode === "--wait" ? [true, false] : [true] : [false]);
      expect(sleeps).toEqual(mode === "--wait" && highOnRetry ? [20, 123] : [20]);
      expect(stderr).toContain("lock acquired after");
      expect(stderr.includes("Waiting for measured CPU pressure")).toBe(highOnRetry);
      expect(f.writer.query("SELECT key FROM tickets").all()).toHaveLength(mode === "--wait" || highOnRetry ? 1 : 0);
      expect(f.writer.query<{ last: number | null }, []>("SELECT last FROM admission").get()!.last === null)
        .toBe(mode === "--wait" || highOnRetry);
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      await output;
      if (held) f.writer.exec("ROLLBACK");
      f.close();
    }
  }, 15_000);
}

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
  test.skipIf(process.platform !== "linux")(`${mode} rechecks its owner after awaiting pressure`, async () => {
    const f = fixture(), preload = path.join(f.dir, "owner-after-pressure.ts");
    fs.writeFileSync(preload, `
      import { GateCpuPressure } from ${JSON.stringify(path.resolve("src/lib/runtime/gateCpuPressure.ts"))};
      // Hold periodic observation so this test requires the post-await guard.
      const interval = globalThis.setInterval;
      globalThis.setInterval = () => interval(() => {}, 1000);
      GateCpuPressure.prototype.check = async function() {
        await new Promise(resolve => {
          process.once("message", resolve);
          process.send("sampling");
        });
        return null;
      };
    `);
    const owner = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    let sampled = false, expired = false;
    const child = Bun.spawn([process.execPath, "--preload", preload, "scripts/cpu-admission.ts", mode, "command:owner-exited", String(owner.pid)], {
      env: { ...process.env, LLV_GATE_LOCK_DIR: f.dir, DELEGATUS_CPU_PRESSURE: "off" },
      stdin: "ignore", stdout: "ignore", stderr: "pipe",
      ipc(message, subprocess) {
        if (message === "sampling") {
          sampled = true;
          owner.kill("SIGTERM");
          void owner.exited.then(() => subprocess.send("sampled"));
        }
      },
    });
    const output = new Response(child.stderr).text();
    const watchdog = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 5000);
    try {
      const code = await child.exited, stderr = await output;
      expect(expired, stderr).toBe(false);
      expect(sampled).toBe(true);
      expect(code, stderr).toBe(130);
      expect(f.writer.query("SELECT key FROM tickets").all()).toEqual([]);
      expect(f.writer.query<{ last: number | null }, []>("SELECT last FROM admission").get()!.last).toBeNull();
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null) child.kill("SIGKILL");
      if (owner.exitCode === null) owner.kill("SIGKILL");
      await Promise.all([child.exited, owner.exited, output]);
      f.close();
    }
  }, 15_000);

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
