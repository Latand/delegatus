// Exercises the shipped installer with real macOS tools and the pinned Bun zip.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const resources = resolve(process.argv[2]);
const base = mkdtempSync(join(tmpdir(), "mac-installer-"));
const original = JSON.parse(readFileSync(join(resources, "runtime-manifest.json"), "utf8"));
const script = resolve("macos/Resources/setup-runtime.sh");
const checks = [];
let active;
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
  assert(!existsSync(join(f.runtime, ".install-lock")), "failed installation releases its lock");
  assert(!existsSync(join(f.runtime, "bun")), "unverified Bun is never published");
  assert(!existsSync(join(f.runtime, "packages")), "unverified package is never published");
  checks.push({ name: f.root.split("/").at(-1), command: "bash macos/Resources/setup-runtime.sh RUNTIME MANIFEST", expectedExit: 1, exit: result.status });
}
try {
  run(fixture("bad-bun-checksum", manifest => { manifest.bun[process.arch === "arm64" ? "arm64" : "x86_64"].sha256 = "0".repeat(64); }), "Bun checksum mismatch");
  const pkg = fixture("bad-package-checksum", manifest => { manifest.mode = "pr"; manifest.delegatus.tarball = "bundle:delegatus.tgz"; manifest.delegatus.integrity = "sha512-invalid"; });
  writeFileSync(join(pkg.root, "delegatus.tgz"), "damaged archive"); run(pkg, "Delegatus checksum mismatch");
  const locked = fixture("lock-contention", () => {});
  mkdirSync(join(locked.runtime, ".install-lock"), { recursive: true });
  const refusal = spawnSync("/bin/bash", [script, locked.runtime, locked.manifest], { encoding: "utf8" });
  assert.equal(refusal.status, 1); assert(refusal.stderr.includes("An installation is already in progress"));
  assert(existsSync(join(locked.runtime, ".install-lock")), "another install owns the lock");
  checks.push({ name: "lock-contention", expectedExit: 1, exit: refusal.status });
  const cancel = fixture("cancel", () => {});
  // A previous package stays byte-for-byte intact across cancellation.
  mkdirSync(join(cancel.runtime, "packages"), { recursive: true });
  const sentinel = join(cancel.runtime, "packages", "keep"); writeFileSync(sentinel, "previous installation");
  const child = spawn("/bin/bash", [script, cancel.runtime, cancel.manifest], { stdio: ["ignore", "pipe", "pipe"] });
  active = child;
  let output = ""; child.stdout.on("data", data => { output += data; }); child.stderr.on("data", () => {});
  let ownedGroup;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && child.exitCode === null) {
    if (output.includes("SETUP 1/3")) {
      const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" }).split("\n");
      const row = rows.find(row => { const parts = row.trim().split(/\s+/); return Number(parts[1]) === child.pid && parts.slice(2).join(" ").endsWith("curl"); });
      if (row) { ownedGroup = Number(row.trim().split(/\s+/)[0]); break; }
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert(ownedGroup, "cancel while a real owned download is in flight");
  const completion = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.kill("SIGTERM");
  const result = await completion;
  assert.equal(result.code, 143); assert.equal(result.signal, null);
  assert(!existsSync(join(cancel.runtime, ".install-lock")));
  assert.equal(readFileSync(sentinel, "utf8"), "previous installation");
  assert.throws(() => process.kill(-ownedGroup, 0), "cancelled download group has exited");
  checks.push({ name: "cancel", expectedExit: 143, exit: result.code, childGroupExited: true });
  console.log(JSON.stringify({ installerChecks: checks, passed: checks.length, failed: 0 }));
} finally {
  if (active && active.exitCode === null && active.signalCode === null) {
    const completion = new Promise(resolve => active.once("exit", resolve));
    active.kill("SIGTERM"); await completion;
  }
  rmSync(base, { recursive: true, force: true });
}
