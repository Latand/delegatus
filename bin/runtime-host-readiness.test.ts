import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { RuntimeHostStartupStore } from "@/runtime-host/runtimeHostStartup";
import { runtimeHostStartupProgress, waitForRuntimeHostStartup } from "./server-runtime.mjs";
import {
  STUB_HOST, availablePort, children, install, readRecord, registerSelfUpdateCleanup, release, start, until,
} from "./__fixtures__/cli-self-update";

registerSelfUpdateCleanup();

function candidate() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-readiness-"));
  const filename = path.join(root, "startup.json");
  const pid = 123;
  const startIdentity = "123:fixture";
  const store = new RuntimeHostStartupStore(filename, {
    pid, startIdentity,
    generation: { image: "fixture", revision: "fixture", container: "fixture" },
    now: () => "2026-01-01T00:00:00.000Z",
  });
  store.begin();
  store.record("fence-acquired");
  return { store, filename, pid, startIdentity, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function clock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => { time += ms; },
  };
}

const timeout = (elapsed: number, progress: string | null, silent: number, ceiling: boolean) =>
  `timed out while starting after ${elapsed}ms; ${ceiling ? "ceiling" : "silent"}; last progress: ${progress ?? "none"}; ${silent}ms ago`;

test("a slow candidate advances the real startup writer beyond the former socket deadline", async () => {
  const c = candidate(), timer = clock();
  try {
    await waitForRuntimeHostStartup({
      ...timer, intervalMs: 1_000, timeout,
      check: async () => timer.now() >= 90_000,
      progress: async () => {
        c.store.progress({ subphase: "hash-chain", done: Math.floor(timer.now() / 20_000), total: 10, committedBatches: 0 });
        return runtimeHostStartupProgress(c.filename, c.pid, c.startIdentity);
      },
    });
    expect(timer.now()).toBe(90_000);
  } finally { c.dispose(); }
});

test("a dead candidate fails immediately even while its last startup record advances", async () => {
  const c = candidate(), timer = clock();
  let dead = false;
  try {
    await expect(waitForRuntimeHostStartup({
      ...timer, timeout,
      check: async () => { if (dead) throw new Error("exit code 3: could not bind socket (EACCES)"); return false; },
      progress: async () => {
        c.store.progress({ subphase: "schema", done: 1, total: 1, committedBatches: 1 });
        dead = true; // Exit during the evidence await must win over that evidence.
        return runtimeHostStartupProgress(c.filename, c.pid, c.startIdentity);
      },
    })).rejects.toThrow("exit code 3: could not bind socket (EACCES)");
    expect(timer.now()).toBe(0);
  } finally { c.dispose(); }
});

test("a candidate that never binds exhausts the absolute ceiling despite ongoing journal work", async () => {
  const c = candidate(), timer = clock();
  try {
    await expect(waitForRuntimeHostStartup({
      ...timer, intervalMs: 1_000, timeout,
      check: async () => false,
      progress: async () => {
        c.store.progress({ subphase: "hash-chain", done: timer.now() / 1_000, total: 1000, committedBatches: 0 });
        return runtimeHostStartupProgress(c.filename, c.pid, c.startIdentity);
      },
    })).rejects.toThrow("timed out while starting after 300000ms; ceiling; last progress: journal hash-chain 299/1000, batches 0; 1000ms ago");
    expect(timer.now()).toBe(300_000);
  } finally { c.dispose(); }
});

test("a probe completing after the ceiling cannot admit a late socket", async () => {
  const timer = clock();
  await expect(waitForRuntimeHostStartup({
    ...timer, timeout,
    check: async () => { await timer.sleep(300_001); return true; },
    progress: async () => [],
  })).rejects.toThrow("timed out while starting after 300001ms; ceiling; last progress: none");
});

for (const evidence of ["unchanged", "timestamp-only", "regressing", "foreign-pid", "foreign-identity", "absent", "unreadable", "oversized"] as const) {
  test(`a silent candidate fails at the silence limit with ${evidence} evidence`, async () => {
    const c = candidate(), timer = clock();
    try {
      c.store.progress({ subphase: "hash-chain", done: 10, total: 100, committedBatches: 1 });
      await expect(waitForRuntimeHostStartup({
        ...timer, intervalMs: 1_000, timeout,
        check: async () => false,
        progress: async () => {
          if (evidence === "timestamp-only") {
            const value = JSON.parse(fs.readFileSync(c.filename, "utf8"));
            value.journal.updatedAt = new Date(timer.now()).toISOString();
            fs.writeFileSync(c.filename, JSON.stringify(value));
          }
          if (evidence === "regressing" && timer.now() > 0) c.store.progress({ subphase: "hash-chain", done: 9, total: 100, committedBatches: 0 });
          if (evidence === "absent") fs.rmSync(c.filename, { force: true });
          if (evidence === "unreadable") fs.writeFileSync(c.filename, "{");
          if (evidence === "oversized") fs.writeFileSync(c.filename, " ".repeat(33 * 1024));
          return runtimeHostStartupProgress(c.filename, evidence === "foreign-pid" ? 124 : c.pid,
            evidence === "foreign-identity" ? "123:other" : c.startIdentity);
        },
      })).rejects.toThrow("timed out while starting after 30000ms; silent; last progress:");
      expect(timer.now()).toBe(30_000);
    } finally { c.dispose(); }
  });
}

test("a restarted wait gets a fresh budget and never inherits the predecessor's progress", async () => {
  const c = candidate();
  try {
    for (let run = 0; run < 2; run++) {
      const timer = clock();
      await expect(waitForRuntimeHostStartup({
        ...timer, intervalMs: 1_000, timeout,
        check: async () => false,
        progress: () => runtimeHostStartupProgress(c.filename, c.pid, run ? "123:replacement" : c.startIdentity),
      })).rejects.toThrow(run ? "last progress: none" : "last progress: fence-acquired");
      expect(timer.now()).toBe(30_000);
    }
  } finally { c.dispose(); }
});

test("the real launcher keeps a slow progressing candidate through release succession", async () => {
  const fixture = install();
  const running = await start(fixture);
  const before = readRecord(fixture.state);
  const next = release(fixture, "slow-host");
  const bundle = await Bun.build({ entrypoints: [path.resolve("src/runtime-host/runtimeHostStartup.ts")], target: "bun" });
  expect(bundle.success).toBe(true);
  fs.writeFileSync(path.join(next.dir, "dist/startup.mjs"), await bundle.outputs[0]!.text());
  fs.writeFileSync(path.join(next.dir, "dist/runtime-host.mjs"), `
import { RuntimeHostStartupStore } from "./startup.mjs";
import { runtimeHostStartIdentity } from "../bin/self-update-supervisor.mjs";
const startup = new RuntimeHostStartupStore(process.env.LLV_RUNTIME_HOST_STARTUP_TARGET ||
  process.env.LLV_STATE_DIR + "/runtime-host-startup/legacy-runtime-host-" + process.pid + ".json", {
    pid: process.pid, startIdentity: runtimeHostStartIdentity(process.pid),
    generation: { image: "fixture", revision: "fixture", container: "fixture" },
});
startup.begin();
startup.record("fence-acquired");
for (let batch = 0; batch < 4; batch++) {
  startup.progress({ subphase: "hash-chain", done: batch, total: 4, committedBatches: batch });
  await Bun.sleep(9000);
}
${STUB_HOST}`);
  fs.writeFileSync(before.releasePointer, JSON.stringify({ ...next, checkoutHead: fixture.first }));
  fs.writeFileSync(before.requestFile, JSON.stringify({ requestId: "slow-host", role: "relaunch", target: next.sha, rollbackPointer: null }));
  const after = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.state === "healthy" && record.runtimeHost.state === "healthy"
      && record.runtimeHost.revision === next.sha.slice(0, 7) ? record : null;
  }, 120_000).catch(error => { throw new Error(`${error}\n${running.output()}`); });
  expect(after.launcher.pid).toBe(before.launcher.pid);
  expect(after.runtimeHost.pid).not.toBe(before.runtimeHost.pid);
  expect(JSON.parse(fs.readFileSync(before.releasePointer, "utf8")).sha).toBe(next.sha);
  expect(running.child.exitCode).toBeNull();
}, 150_000);

for (const [mode, lang] of [["dead", "en"], ["silent", "en"], ["dead", "uk"], ["silent", "uk"]] as const) {
  test(`the real launcher reports the ${mode} candidate's cause in ${lang}`, async () => {
    const fixture = install();
    fs.writeFileSync(path.join(fixture.checkout, "dist/runtime-host.mjs"), mode === "dead"
      ? `import fs from "node:fs"; import net from "node:net";
const parent = process.env.LLV_STATE_DIR + "/blocked-parent";
fs.writeFileSync(parent, "file");
const server = net.createServer();
server.listen(parent + "/host.sock");`
      : 'setInterval(() => {}, 1000);');
    const child = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "bin/cli.mjs"), "--no-open", "--port", String(await availablePort())], {
      cwd: fixture.checkout, env: { ...fixture.env, LLV_LANG: lang }, stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let output = "";
    child.stdout!.on("data", chunk => { output += String(chunk); });
    child.stderr!.on("data", chunk => { output += String(chunk); });
    await until(() => child.exitCode !== null, 90_000);
    expect(child.exitCode).toBe(1);
    if (mode === "dead") {
      const reported = output.split("\n").findLast(line => line.includes(lang === "en"
        ? "Couldn't start the structured runtime host:" : "Не вдалося запустити structured runtime host:"));
      expect(reported).toContain("exit code 1");
      expect(reported).toContain("Failed to listen at");
      expect(reported).toContain("blocked-parent/host.sock");
      expect(output).toMatch(lang === "en" ? /elapsed: \d+ms/ : /минуло: \d+ мс/);
      expect(output).not.toContain("timed out while starting");
    } else {
      expect(output).toContain(lang === "en" ? "timed out while starting after" : "перевищив час запуску");
      expect(output).toContain(lang === "en" ? "no startup progress" : "немає поступу запуску");
      expect(output).toContain(lang === "en" ? "last progress: none" : "останній поступ: відсутній");
    }
    expect(output).not.toContain("check the socket directory permissions");
    expect(output).not.toContain("перевірте права каталогу сокета");
  }, 120_000);
}
