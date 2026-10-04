import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

async function fixture() {
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
      server.listen(endpoint, () => writeFileSync(process.env.LLV_RUNTIME_HOST_FENCE, JSON.stringify({ pid: process.pid, startIdentity: runtimeHostStartIdentity(process.pid), acquisitionId: "fixture-acquisition-id" })));
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
  const args = ["--no-open", "--port", String(port)];
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
  old.stdout!.on("data", data => { output += data; });
  old.stderr!.on("data", data => { output += data; });
  const before = await until(() => { const record = readRecord(); return record?.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null; }, 20000).catch(error => { throw new Error(String(error) + " (exit " + old.exitCode + ")\n" + output + "\n" + JSON.stringify(readRecord())); });
  const apply = new ApplyController(path.dirname(recordFile));
  apply.begin(before, target, "operator");
  writeFileSync(pointer, JSON.stringify({ kind: "package", sha: target, dir: candidate, baseVersion: "0.0.0", version: "0.0.2" }));
  apply.patch({ state: "ready" });
  const requestFile = process.platform === "win32" ? before.requestFile : path.win32.join("C:\\fixtures\\request-context\\self-update", path.basename(before.requestFile));
  const plan = Buffer.from(JSON.stringify({ root: base, requestFile, releasePointer: pointer, target, rollbackPointer, priorRevision: priorSha.slice(0, 7), priorVersion: "0.0.1", checkout: false })).toString("base64");
  const bootstrap = (encoded = plan) => {
    const preload = process.platform === "win32" ? [] : ["--preload", path.resolve("bin/__fixtures__/windows-state-paths.preload.ts")];
    const child = spawn(process.execPath, ["--bun", ...preload, path.resolve("bin/launcher-relaunch.mjs"), "--terminal", encoded, path.join(candidate, "bin", "cli.mjs"), ...args],
      { cwd: base, env: { ...env, LLV_TEST_WINDOWS_STATE_ROOT: root }, stdio: ["ignore", "pipe", "pipe"] }); children.add(child);
    let error = ""; child.stderr!.on("data", data => { error += data; });
    return { child, error: () => error };
  };
  return { old, before, candidate, prior, pointer, rollbackPointer, apply, readRecord, bootstrap, plan, port, env };
}

for (const rollback of [false, true]) test(`Windows request-context terminal entrypoint settles rollback=${rollback}`, async () => {
  const f = await fixture();
  if (rollback) writeFileSync(path.join(f.candidate, "bin", "cli.mjs"), 'throw new Error("synthetic import failure");\n');
  await stop(f.old); await stopRecorded(f.before);
  const run = f.bootstrap();
  const record = await until(() => {
    const value = f.readRecord();
    return value?.launcher.pid !== f.before.launcher.pid && value?.web.state === "healthy" && value.runtimeHost.state === "healthy" ? value : null;
  });
  await until(() => run.child.exitCode !== null ? true : null);
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
