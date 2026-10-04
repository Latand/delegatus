import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { isAlive } from "../src/lib/selfUpdate/pid";
import { ApplyController } from "../src/lib/selfUpdate/apply";
import type { LauncherRecord } from "../src/lib/selfUpdate/launcher";
import { readStartIdentity } from "./self-update-supervisor.mjs";

const roots: string[] = [];
const children = new Set<ReturnType<typeof spawn>>();
const owners = new Map<number, string>();

async function stop(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, Bun.sleep(3000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
}
async function stopRecorded(record: LauncherRecord) {
  // Windows termination can end the forwarding bootstrap before its signal
  // reaches the supervisor. Stop only the processes this fixture recorded.
  for (const entry of [record.launcher, record.web, record.runtimeHost]) {
    if (!entry.pid || !entry.startIdentity || !isAlive(entry.pid) || readStartIdentity(entry.pid) !== entry.startIdentity) continue;
    process.kill(entry.pid, "SIGTERM");
    const deadline = Date.now() + 3000;
    while (isAlive(entry.pid) && Date.now() < deadline) await Bun.sleep(25);
    if (isAlive(entry.pid) && readStartIdentity(entry.pid) === entry.startIdentity) process.kill(entry.pid, "SIGKILL");
  }
}
afterEach(async () => {
  for (const child of children) await stop(child);
  children.clear();
  // Detached supervisors are owned by the bootstrap. Capture their genuine
  // records while observing them and signal only those recorded identities.
  for (const [pid, identity] of owners) {
    if (!isAlive(pid) || readStartIdentity(pid) !== identity) continue;
    try { process.kill(pid, "SIGTERM"); } catch { continue; }
    const deadline = Date.now() + 3000;
    while (isAlive(pid) && Date.now() < deadline) await Bun.sleep(25);
    if (isAlive(pid) && readStartIdentity(pid) === identity) { try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ } }
  }
  owners.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
}, 20000);

async function until<T>(read: () => T | null | false, budget = process.platform === "win32" ? 30000 : 10000): Promise<T> {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await Bun.sleep(25);
  }
  throw new Error("Terminal handoff did not settle");
}

async function fixture(equalsPort = false) {
  const root = mkdtempSync(path.join(process.platform === "win32" ? tmpdir() : "/var/tmp", "dlg-terminal-")); roots.push(root);
  const state = path.join(root, "request-context");
  const base = path.join(root, "package");
  const prior = path.join(root, "prior");
  const candidate = path.join(root, "candidate");
  const binSource = path.resolve("bin");
  for (const [directory, version] of [[base, "0.0.0"], [prior, "0.0.1"], [candidate, "0.0.2"]]) {
    mkdirSync(path.join(directory, "bin"), { recursive: true });
    mkdirSync(path.join(directory, "dist", "standalone"), { recursive: true });
    for (const name of readdirSync(binSource).filter(name => name.endsWith(".mjs"))) copyFileSync(path.join(binSource, name), path.join(directory, "bin", name));
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({ type: "module", version }));
    writeFileSync(path.join(directory, "dist", "standalone", "server.js"), `
      const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch(request) {
        if (request.headers.get("authorization") !== "Bearer synthetic-terminal-key") return new Response("Unauthorized", { status: 401 });
        return new Response(new URL(request.url).pathname === "/chunk.js" ? "void 0" : '<script src="/chunk.js"></script>' + process.cwd());
      } });
      process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
    `);
    writeFileSync(path.join(directory, "dist", "runtime-host.mjs"), `
      import net from "node:net";
      import { writeFileSync, rmSync } from "node:fs";
      import { readStartIdentity, runtimeHostStartIdentity } from "../bin/self-update-supervisor.mjs";
      const endpoint = process.env.LLV_RUNTIME_HOST_SOCKET;
      if (process.platform !== "win32") rmSync(endpoint, { force: true });
      const server = net.createServer(socket => {
        socket.on("error", () => {});
        socket.on("data", frame => { const request = JSON.parse(String(frame));
          socket.end(JSON.stringify({ id: request.id, ok: true, result: { pid: process.pid, startIdentity: readStartIdentity(process.pid), hostEpoch: 1 } }) + "\\n");
        });
      });
      // Publish the genuine owner before the endpoint is connectable, matching
      // runtime-host main's fence-before-listen order. Windows termination can
      // leave the predecessor's fence behind without running its SIGTERM hook.
      writeFileSync(process.env.LLV_RUNTIME_HOST_FENCE, JSON.stringify({ pid: process.pid, startIdentity: runtimeHostStartIdentity(process.pid), acquisitionId: "fixture-acquisition-id" }));
      server.listen(endpoint);
      process.on("SIGTERM", () => server.close(() => { rmSync(process.env.LLV_RUNTIME_HOST_FENCE, { force: true }); process.exit(0); }));
    `);
  }
  mkdirSync(path.join(state, "self-update"), { recursive: true });
  const id = createHash("sha256").update(path.resolve(base)).digest("hex").slice(0, 16);
  const recordFile = path.join(state, "self-update", `launcher-${id}.json`);
  const pointer = path.join(state, "self-update", `release-${id}.json`);
  const priorSha = "a".repeat(40), target = "b".repeat(40);
  const rollbackPointer = JSON.stringify({ kind: "package", sha: priorSha, dir: prior, baseVersion: "0.0.0", version: "0.0.1" }) + "\n";
  writeFileSync(pointer, rollbackPointer);
  const env = { ...process.env, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"),
    LLV_STATE_DIR: state, LLV_BUN_EXECUTABLE: process.execPath, LLV_TOKEN: "synthetic-terminal-key", TMPDIR: root, TMP: root, TEMP: root };
  const listener = net.createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const args = equalsPort ? ["--no-open", `--port=${port}`] : ["--no-open", "--port", String(port)];
  const start = (entry: string, argv: string[] = args) => {
    const child = spawn(process.execPath, ["--bun", entry, ...argv], { cwd: base, env, stdio: ["ignore", "pipe", "pipe"] }); children.add(child); return child;
  };
  const readRecord = (): LauncherRecord | null => {
    if (!existsSync(recordFile)) return null;
    let record: LauncherRecord;
    try { record = JSON.parse(readFileSync(recordFile, "utf8")); } catch { return null; }
    for (const entry of [record.launcher, record.web, record.runtimeHost]) if (entry.pid && entry.startIdentity) owners.set(entry.pid, entry.startIdentity);
    return record;
  };
  const old = start(path.join(base, "bin", "cli.mjs"));
  let output = "";
  old.stdout!.on("data", data => { output = (output + data).slice(-4096); });
  old.stderr!.on("data", data => { output = (output + data).slice(-4096); });
  const before = await until(() => { const record = readRecord(); return record?.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null; }, 20000).catch(error => { throw new Error(String(error) + " (exit " + old.exitCode + ")\n" + output + "\n" + JSON.stringify(readRecord())); });
  const apply = new ApplyController(path.dirname(recordFile));
  apply.begin(before, target, "operator");
  writeFileSync(pointer, JSON.stringify({ kind: "package", sha: target, dir: candidate, baseVersion: "0.0.0", version: "0.0.2" }));
  apply.patch({ state: "ready" });
  const requestFile = process.platform === "win32" ? before.requestFile : path.win32.join("C:\\fixtures\\request-context\\self-update", path.basename(before.requestFile));
  const plan = Buffer.from(JSON.stringify({ root: base, requestFile, releasePointer: pointer, target, rollbackPointer, priorRevision: priorSha.slice(0, 7), priorVersion: "0.0.1", checkout: false })).toString("base64");
  // Observe ignored descendant output through files, so detached children keep
  // their existing lifetime and never block on an undrained pipe.
  const diagnosticsDir = path.join(root, "diagnostics");
  mkdirSync(diagnosticsDir);
  const diagnosticsPreload = path.join(root, "diagnostics.preload.mjs");
  writeFileSync(diagnosticsPreload, `
    import cp from "node:child_process";
    import { mock } from "bun:test";
    import { appendFileSync, openSync, closeSync } from "node:fs";
    import path from "node:path";
    const directory = ${JSON.stringify(diagnosticsDir)};
    if (process.env.LLV_TEST_PROBE_PORT) {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (input, options) => {
        const url = new URL(typeof input === "string" ? input : input.url);
        if (url.port !== process.env.LLV_TEST_PROBE_PORT) {
          appendFileSync(path.join(directory, "foreign-probe"), "refused");
          throw new Error("Probe refused before reaching an unowned port");
        }
        appendFileSync(path.join(directory, "owned-probes"), url.port + "\\n");
        return originalFetch(input, options);
      };
    }
    appendFileSync(path.join(directory, process.pid + ".preload.jsonl"), JSON.stringify({ pid: process.pid, execArgv: process.execArgv }) + "\\n");
    const observed = { ...cp };
    let sequence = 0;
    for (const method of ["spawn", "spawnSync"]) {
      const original = cp[method];
      observed[method] = function(command, args, options) {
        if (command !== process.execPath || options?.stdio !== "ignore") return original(command, args, options);
        const name = process.pid + "-" + (++sequence);
        const files = ["stdout", "stderr"].map(stream => openSync(path.join(directory, name + "." + stream), "a"));
        const trace = value => appendFileSync(path.join(directory, name + ".jsonl"), JSON.stringify(value) + "\\n");
        try {
          const child = original(command, args, { ...options, stdio: ["ignore", ...files] });
          trace({ method, pid: child.pid, entry: args.findLast(arg => /\\.(mjs|js)$/.test(arg)), argv: args.map(arg => arg.length > 256 ? "<long-argument>" : arg), status: child.status, signal: child.signal, error: child.error?.message });
          if (method === "spawn") {
            child.once("exit", (code, signal) => trace({ code, signal }));
            child.once("error", error => trace({ error: error.message }));
          }
          return child;
        } finally { files.forEach(fd => closeSync(fd)); }
      };
    }
    mock.module("node:child_process", () => ({ ...observed, default: observed }));
  `);
  const bootstrap = (encoded = plan) => {
    const preload = ["--preload", diagnosticsPreload, ...(process.platform === "win32" ? [] : ["--preload", path.resolve("bin/__fixtures__/windows-state-paths.preload.ts")])];
    const child = spawn(process.execPath, ["--bun", ...preload, path.resolve("bin/launcher-relaunch.mjs"), "--terminal", encoded, path.join(candidate, "bin", "cli.mjs"), ...args],
      { cwd: base, env: { ...env, LLV_TEST_WINDOWS_STATE_ROOT: root, ...(equalsPort ? { LLV_TEST_PROBE_PORT: String(port) } : {}) }, stdio: ["ignore", "pipe", "pipe"] }); children.add(child);
    let error = "", stdout = "";
    child.stderr!.on("data", data => { error = (error + data).slice(-4096); });
    child.stdout!.on("data", data => { stdout = (stdout + data).slice(-4096); });
    return { child, error: () => error, stdout: () => stdout };
  };
  const diagnose = async (observation: string, run: ReturnType<typeof bootstrap>) => {
    const sanitize = (value: string) => [root, process.execPath, path.resolve(".")].reduce((text, localPath, index) => {
      const label = ["<fixture>", "<bun>", "<repo>"][index];
      for (let level = 0; level < 3; level++) {
        text = text.split(localPath).join(label);
        localPath = localPath.replaceAll("\\", "\\\\");
      }
      return text;
    }, value)
      .split("synthetic-terminal-key").join("<synthetic-key>").slice(-4096);
    const print = (item: string, value: unknown) => console.error("[terminal-diagnostic] " + item + " " + sanitize(typeof value === "string" ? value : JSON.stringify(value)));
    const tail = (file: string) => {
      const fd = openSync(file, "r");
      try {
        const size = statSync(file).size, bytes = Buffer.alloc(Math.min(size, 4096));
        readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
        return bytes.toString("utf8");
      } finally { closeSync(fd); }
    };
    print("waiting", observation);
    print("old-child", { pid: old.pid, code: old.exitCode, signal: old.signalCode, output });
    print("bootstrap", { pid: run.child.pid, code: run.child.exitCode, signal: run.child.signalCode, stdout: run.stdout(), stderr: run.error() });
    for (const directory of [state, path.dirname(recordFile), diagnosticsDir]) {
      const names = readdirSync(directory).sort();
      print("directory", { directory, names });
      for (const name of names.slice(0, 24)) {
        const file = path.join(directory, name);
        try { if (statSync(file).isFile()) print(name, tail(file)); } catch (error) { print(name, String(error)); }
      }
    }
    for (const [label, record] of [["before", before], ["current", readRecord()]] as const) {
      if (!record) continue;
      for (const role of ["launcher", "web", "runtimeHost"] as const) {
        const entry = record[role];
        print(label + "-" + role, { ...entry, alive: entry.pid ? isAlive(entry.pid) : false,
          comparedIdentity: entry.pid ? readStartIdentity(entry.pid) : null });
      }
    }
    try {
      const page = await fetch(`http://127.0.0.1:${port}/`, { headers: { authorization: "Bearer " + env.LLV_TOKEN }, signal: AbortSignal.timeout(2000) });
      print("page-health", { status: page.status, body: (await page.text()).slice(0, 2048) });
    } catch (error) { print("page-health", String(error)); }
  };
  return { old, before, candidate, prior, pointer, rollbackPointer, apply, readRecord, bootstrap, plan, port, env, diagnose, diagnosticsDir };
}

for (const rollback of [false, true]) test(`Windows request-context terminal entrypoint settles rollback=${rollback}`, async () => {
  const f = await fixture();
  if (rollback) writeFileSync(path.join(f.candidate, "bin", "cli.mjs"), 'throw new Error("synthetic import failure");\n');
  await stop(f.old); await stopRecorded(f.before);
  const run = f.bootstrap();
  const record = await until(() => {
    const value = f.readRecord();
    return value?.launcher.pid !== f.before.launcher.pid && value?.web.state === "healthy" && value.runtimeHost.state === "healthy" ? value : null;
  }).catch(async error => { await f.diagnose("replacement owner with web/runtimeHost healthy", run); throw error; });
  await until(() => run.child.exitCode !== null ? true : null)
    .catch(async error => { await f.diagnose("bootstrap exit after replacement became healthy", run); throw error; });
  expect(run.child.exitCode).toBe(rollback ? 1 : 0);
  if (rollback) {
    expect(run.error()).toContain("verified prior release");
    expect(readFileSync(f.pointer, "utf8")).toBe(f.rollbackPointer);
  }
  expect(record.web.revision).toBe((rollback ? "a" : "b").repeat(7));
  expect(record.runtimeHost.revision).toBe(record.web.revision);
  for (const entry of [record.launcher, record.web, record.runtimeHost]) expect(readStartIdentity(entry.pid!)).toBe(entry.startIdentity);
  const trialFile = path.join(path.dirname(f.before.requestFile), path.basename(f.before.requestFile).replace(/^request/, "trial"));
  expect(existsSync(trialFile)).toBe(false);
  expect(record.launcher.requestId).toBe(f.apply.current!.requestId);
  const cold = new ApplyController(path.dirname(f.before.requestFile));
  expect(cold.observe(record)).toBe(rollback ? "failed" : "done");
  expect(cold.current).toMatchObject({ requestId: f.apply.current!.requestId, rolledBack: rollback });
  const page = await fetch(`http://127.0.0.1:${f.port}/`, { headers: { authorization: "Bearer " + f.env.LLV_TOKEN }, signal: AbortSignal.timeout(2000) });
  expect(await page.text()).toContain(path.join(rollback ? f.prior : f.candidate, "dist", "standalone"));
}, 90000);

test("Windows request-context terminal entrypoint refuses a competing live owner without changing custody", async () => {
  const f = await fixture();
  const before = readFileSync(path.join(path.dirname(f.before.requestFile), "apply.json"), "utf8");
  const run = f.bootstrap();
  await until(() => run.child.exitCode !== null ? true : null);
  expect(run.child.exitCode).toBe(1);
  expect(run.error()).toContain("A live launcher already supervises this installation.");
  expect(readFileSync(path.join(path.dirname(f.before.requestFile), "apply.json"), "utf8")).toBe(before);
  expect(f.readRecord()!.launcher.pid).toBe(f.before.launcher.pid);
  expect(existsSync(path.join(path.dirname(f.before.requestFile), path.basename(f.before.requestFile).replace(/^request/, "trial")))).toBe(false);
}, 90000);

test("terminal entrypoint refuses an invalid request filename before changing custody", async () => {
  const f = await fixture();
  await stop(f.old); await stopRecorded(f.before);
  const plan = JSON.parse(Buffer.from(f.plan, "base64").toString("utf8"));
  plan.requestFile = path.win32.join(path.win32.dirname(plan.requestFile), "unrelated.json");
  const before = readFileSync(path.join(path.dirname(f.before.requestFile), "apply.json"), "utf8");
  const run = f.bootstrap(Buffer.from(JSON.stringify(plan)).toString("base64"));
  await until(() => run.child.exitCode !== null ? true : null);
  expect(run.child.exitCode).toBe(1);
  expect(run.error()).toContain("Invalid launcher request filename");
  expect(readFileSync(path.join(path.dirname(f.before.requestFile), "apply.json"), "utf8")).toBe(before);
}, 90000);

for (const rollback of [false, true]) test(`equals-port terminal entrypoint probes only its owned listener, rollback=${rollback}`, async () => {
  const f = await fixture(true);
  if (rollback) writeFileSync(path.join(f.candidate, "bin", "cli.mjs"), 'throw new Error("synthetic import failure");\n');
  await stop(f.old); await stopRecorded(f.before);
  const run = f.bootstrap();
  await until(() => run.child.exitCode !== null ? true : null);
  expect(existsSync(path.join(f.diagnosticsDir, "foreign-probe"))).toBe(false);
  expect(run.child.exitCode).toBe(rollback ? 1 : 0);
  const probes = readFileSync(path.join(f.diagnosticsDir, "owned-probes"), "utf8").trim().split("\n");
  expect(probes.length).toBeGreaterThan(0);
  expect(probes.every(port => port === String(f.port))).toBe(true);
  const record = f.readRecord()!;
  expect(record.web.revision).toBe((rollback ? "a" : "b").repeat(7));
  expect(record.runtimeHost.revision).toBe(record.web.revision);
}, 90000);
