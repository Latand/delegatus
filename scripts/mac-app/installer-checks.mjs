// Exercises the shipped installer with real macOS tools and the pinned Bun zip.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, utimesSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:https";
import { once } from "node:events";
import assert from "node:assert/strict";

const resources = resolve(process.argv[2]);
const base = mkdtempSync(join(tmpdir(), "mac-installer-"));
const original = JSON.parse(readFileSync(join(resources, "runtime-manifest.json"), "utf8"));
const script = resolve("macos/Resources/setup-runtime.sh");
const checks = [];
const topologyOnly = process.argv.includes("--topology-only");
const children = new Set();
const identities = new Map();
let server;
const sockets = new Set();
function tracked(command, args, options) {
  const child = spawn(command, args, options);
  child.completion = new Promise(resolve => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", error => resolve({ error }));
  });
  children.add(child);
  child.stdin?.on("error", error => { if (error.code !== "EPIPE") throw error; });
  return child;
}
async function bounded(promise, reason, ms = 15_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), ms); })]); }
  finally { clearTimeout(timer); }
}
function rows(args = ["-axo", "pid=,ppid=,pgid=,lstart=,comm="]) {
  return execFileSync("/bin/ps", args, { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim().split("\n").filter(Boolean).map(row => {
    const fields = row.trim().split(/\s+/);
    return { pid: Number(fields[0]), parent: Number(fields[1]), group: Number(fields[2]), start: fields.slice(3, 8).join(" "), command: fields.slice(8).join(" ") };
  });
}
function descendants(root) {
  const snapshot = rows();
  const owned = new Set([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of snapshot) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; }
  }
  const confirmed = snapshot.filter(row => owned.has(row.pid));
  for (const row of confirmed) identities.set(row.pid, row);
  return confirmed;
}
function stillOwned(identity) {
  try { return rows(["-p", String(identity.pid), "-o", "pid=,ppid=,pgid=,lstart=,comm="]).some(row => row.pid === identity.pid && row.start === identity.start && row.command === identity.command); }
  catch { return false; }
}
function lockProbe(path) {
  return spawnSync("/usr/bin/lockf", ["-k", "-t", "0", path, "/usr/bin/true"], { encoding: "utf8", timeout: 5000 });
}
function fixture(name, mutate) {
  const root = join(base, name); mkdirSync(root);
  const manifest = structuredClone(original); mutate(manifest);
  writeFileSync(join(root, "runtime-manifest.json"), JSON.stringify(manifest));
  return { root, runtime: join(root, "Runtime"), manifest: join(root, "runtime-manifest.json") };
}
function run(f, reason) {
  const result = spawnSync("/bin/bash", [script, f.runtime, f.manifest], { encoding: "utf8", timeout: 360_000 });
  assert.equal(result.status, 1, result.stderr);
  assert(result.stderr.includes(reason), `expected ${reason}; received ${result.stderr}`);
  assert(existsSync(join(f.runtime, ".install-lock-v2")), "kernel lock inode remains available for subsequent attempts");
  assert(!existsSync(join(f.runtime, "bun")), "unverified Bun is never published");
  assert(!existsSync(join(f.runtime, "packages")), "unverified package is never published");
  checks.push({ name: f.root.split("/").at(-1), command: "bash macos/Resources/setup-runtime.sh RUNTIME MANIFEST", expectedExit: 1, exit: result.status });
}
try {
  if (!topologyOnly) {
    run(fixture("bad-bun-checksum", manifest => { manifest.bun[process.arch === "arm64" ? "arm64" : "x86_64"].sha256 = "0".repeat(64); }), "Bun checksum mismatch");
    const pkg = fixture("bad-package-checksum", manifest => { manifest.mode = "pr"; manifest.delegatus.tarball = "bundle:delegatus.tgz"; manifest.delegatus.integrity = "sha512-invalid"; });
    writeFileSync(join(pkg.root, "delegatus.tgz"), "damaged archive"); run(pkg, "Delegatus checksum mismatch");
  }
  const locked = fixture("lock-contention", () => {});
  mkdirSync(locked.runtime, { recursive: true });
  const lockPath = join(locked.runtime, ".install-lock-v2");
  // Hold the owner behind a barrier before acquisition. READY is emitted by
  // lockf's child, so it proves actual lock ownership regardless of CPU delay.
  const lockOwner = tracked("/bin/bash", ["-c", 'read -r gate; exec "$@"', "bash", "/usr/bin/lockf", "-k", "-t", "5", lockPath,
    "/bin/bash", "-c", 'printf "READY\\n"; read -r release'], { stdio: ["pipe", "pipe", "pipe"] });
  const ready = new Promise(resolve => lockOwner.stdout.on("data", chunk => { if (chunk.toString().includes("READY")) resolve(); }));
  assert(!existsSync(lockPath), "delayed owner has not taken the lock before its barrier opens");
  lockOwner.stdin.write("acquire\n");
  await bounded(ready, "lock owner never acquired the lock");
  descendants(lockOwner.pid);
  assert.equal(lockProbe(lockPath).status, 75, "the kernel lock is held after READY");
  const refusal = spawnSync("/bin/bash", [script, locked.runtime, locked.manifest], { encoding: "utf8", timeout: 5000 });
  assert.equal(refusal.status, 1); assert(refusal.stderr.includes("An installation is already in progress"));
  lockOwner.stdin.end("release\n");
  assert.equal((await bounded(lockOwner.completion, "lock owner did not exit")).code, 0);
  assert.equal(lockProbe(lockPath).status, 0, "the operating system releases the lock after owner exit");
  checks.push({ name: "lock-contention", expectedExit: 1, exit: refusal.status, heldAfterReadiness: true, releasedAfterExit: true });
  if (!topologyOnly) {
    const abandoned = fixture("abandoned-lock-recovery", manifest => { manifest.bun[process.arch === "arm64" ? "arm64" : "x86_64"].sha256 = "0".repeat(64); });
    mkdirSync(abandoned.runtime, { recursive: true });
    mkdirSync(join(abandoned.runtime, ".install-lock"), { recursive: true });
    writeFileSync(join(abandoned.runtime, ".install-lock", "pid"), "99999999\n");
    const stale = new Date(Date.now() - 180_000);
    utimesSync(join(abandoned.runtime, ".install-lock"), stale, stale);
    run(abandoned, "Bun checksum mismatch");
    checks.push({ name: "abandoned-lock-recovered", expectedExit: 1, exit: 1 });
  }
  // A local HTTPS peer holds the real curl in flight until cancellation.
  // No download speed, network availability or polling delay selects the race.
  const tlsConfig = join(base, "tls.cnf");
  const cert = join(base, "cert.pem"), key = join(base, "key.pem");
  writeFileSync(tlsConfig, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n");
  execFileSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", tlsConfig, "-keyout", key, "-out", cert], { stdio: "ignore" });
  server = createServer({ cert: readFileSync(cert), key: readFileSync(key) });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const cancel = fixture(`cancel-${signal}`, manifest => {
      manifest.bun[process.arch === "arm64" ? "arm64" : "x86_64"].url = `https://127.0.0.1:${server.address().port}/bun.zip`;
    });
    mkdirSync(join(cancel.runtime, "packages"), { recursive: true });
    const sentinel = join(cancel.runtime, "packages", "keep"); writeFileSync(sentinel, "previous installation");
    // Hold the filesystem cleanup itself to prove lockf cannot release the
    // lock before rollback. All other rm calls use the system tool unchanged.
    const bin = join(cancel.root, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "rm"), '#!/bin/bash\nif [[ "$1" = -rf && "$2" = "$ROLLBACK_RUNTIME"/.stage.* ]]; then\n  printf "ROLLBACK-HELD\\n"\n  read -r release\nfi\nexec /bin/rm "$@"\n', { mode: 0o700 });
    const request = once(server, "request");
    const child = tracked("/bin/bash", [script, cancel.runtime, cancel.manifest], {
      env: { ...process.env, CURL_CA_BUNDLE: cert, NO_PROXY: "127.0.0.1", PATH: `${bin}:${process.env.PATH}`, ROLLBACK_RUNTIME: cancel.runtime }, stdio: ["pipe", "pipe", "pipe"]
    });
    let errors = "", output = "";
    const rollback = new Promise(resolve => child.stdout.on("data", data => { output += data; if (output.includes("ROLLBACK-HELD")) resolve(); }));
    child.stderr.on("data", data => { errors += data; });
    await bounded(Promise.race([request, child.completion.then(result => { throw new Error(`installer exited before download: ${JSON.stringify(result)} ${errors}`); })]), "owned download did not reach HTTPS peer");
    const tree = descendants(child.pid);
    const download = tree.find(row => ["/usr/bin/curl", "curl"].includes(row.command) && row.pid !== child.pid);
    assert(download, "cancel while a confirmed descendant curl is in flight");
    assert.equal(download.group, download.pid, "download owns its supervised process group");
    const parent = tree.find(row => row.pid === download.parent);
    assert(parent && parent.pid !== child.pid, "download is owned by the inner installer through lockf");
    const chain = [download];
    while (chain.at(-1).pid !== child.pid) {
      const ancestor = tree.find(row => row.pid === chain.at(-1).parent);
      assert(ancestor && !chain.includes(ancestor), "confirmed ancestry reaches the outer installer");
      chain.push(ancestor);
    }
    assert(chain.length >= 4 && chain.at(-2).command.split("/").at(-1) === "lockf", "real entry point retains the lockf supervisor");
    const lock = join(cancel.runtime, ".install-lock-v2");
    assert.equal(lockProbe(lock).status, 75, "installer holds the lock while curl is active");
    child.kill(signal);
    await bounded(rollback, "installer did not start rollback", 10_000);
    assert.equal(child.exitCode, null, "outer installer waits for rollback");
    assert(readdirSync(cancel.runtime).some(name => name.startsWith(".stage.")), "rollback is held before removing staging");
    assert.equal(lockProbe(lock).status, 75, "lock stays held until rollback finishes");
    child.kill(signal); // Repeated Cancel/Quit cannot interrupt rollback.
    child.stdin.end("release\n");
    const result = await bounded(child.completion, "installer did not finish rollback", 10_000);
    assert.equal(result.code, signal === "SIGTERM" ? 143 : 130, errors); assert.equal(result.signal, null);
    assert.equal(readFileSync(sentinel, "utf8"), "previous installation");
    assert(!readdirSync(cancel.runtime).some(name => name.startsWith(".stage.") || name.startsWith(".supervisor.")), "rollback removes staging and supervision state");
    assert(!existsSync(join(cancel.runtime, "bun")), "cancel never publishes Bun");
    assert.throws(() => process.kill(-download.group, 0), "cancelled download group has exited");
    assert(tree.filter(row => row.pid !== child.pid).every(row => !stillOwned(row)), "all confirmed installer descendants have exited");
    assert(existsSync(lock), "kernel lock inode remains available after cancellation");
    assert.equal(lockProbe(lock).status, 0, "rollback releases the kernel lock");
    checks.push({ name: `cancel-${signal}`, expectedExit: result.code, exit: result.code, topology: chain.reverse().map(row => row.command.split("/").at(-1)), descendantDownloadExited: true, lockHeldThroughRollback: true, lockReleased: true });
  }
  console.log(JSON.stringify({ installerChecks: checks, passed: checks.length, failed: 0 }));
} finally {
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise(resolve => server.close(resolve));
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    descendants(child.pid);
    if (child.stdin && !child.stdin.writableEnded) child.stdin.end("release\n");
    child.kill("SIGTERM");
    try { await bounded(child.completion, "fixture cleanup timed out", 8000); }
    catch {
      for (const identity of [...identities.values()].reverse()) if (stillOwned(identity)) {
        try { process.kill(identity.group === identity.pid ? -identity.group : identity.pid, "SIGKILL"); } catch {}
      }
      child.kill("SIGKILL"); await bounded(child.completion, "fixture could not be reaped", 3000);
    }
  }
  // Also reap captured descendants if an assertion failed after the outer exited.
  for (const identity of [...identities.values()].reverse()) if (stillOwned(identity)) {
    try { process.kill(identity.group === identity.pid ? -identity.group : identity.pid, "SIGKILL"); } catch {}
  }
  rmSync(base, { recursive: true, force: true });
}
