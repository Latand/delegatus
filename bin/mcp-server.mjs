#!/usr/bin/env node

/* FIRST: fold DELEGATUS_* into LLV_* before anything below reads the
   environment (docs/design/rename-delegatus.md §5). */
import "./envAlias.mjs";

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, fstatSync, readFileSync, mkdirSync, renameSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

import { appDirIn } from "./appDir.mjs";
import {
  discardWakatimeEnvironmentCredential,
  viewerChildProcessOptions,
  viewerServerBunRuntime,
} from "./server-runtime.mjs";

discardWakatimeEnvironmentCredential();

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = process.env.LLV_STATE_DIR || join(appDirIn(process.env.XDG_CONFIG_HOME || join(homedir(), ".config")), "state");
const targetFile = process.env.LLV_VIEWER_DEPLOY_TARGET || join(stateDir, "viewer-release.json");
const capability = process.env.LLV_SPAWN_CAPABILITY;
const heartbeatPath = /^[A-Za-z0-9_-]{43}$/.test(capability || "")
  ? join(stateDir, "mcp-runtime", "sessions", `${createHash("sha256").update(capability).digest("hex")}.json`)
  : null;
const startedAt = new Date().toISOString();
let lastSuccessfulCallAt = null;
let failedCalls = 0;
let ready = false;
let unreadySince = startedAt;
let activeReleaseId = null;

function heartbeat() {
  if (!heartbeatPath) return;
  try {
    mkdirSync(dirname(heartbeatPath), { recursive: true, mode: 0o700 });
    const temporary = `${heartbeatPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ pid: process.pid, startedAt, checkedAt: new Date().toISOString(), ready, unreadySince, releaseId: activeReleaseId, lastSuccessfulCallAt, failedCalls }), { mode: 0o600 });
    renameSync(temporary, heartbeatPath);
  } catch (error) {
    console.error(`Viewer MCP liveness write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const heartbeatTimer = setInterval(heartbeat, 30_000);
heartbeatTimer.unref();
heartbeat();

function deployedPackageRoot() {
  /* `os.homedir()` rather than `$HOME` with a Linux-shaped default: on Windows
     HOME is not a Windows variable at all, and the fallback named a directory
     that exists on no machine running this. */
  let target;
  try {
    target = JSON.parse(readFileSync(targetFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return packageRoot;
    throw new Error(`Could not read the Viewer release target: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!target
    || typeof target !== "object"
    || Array.isArray(target)
    || typeof target.image !== "string"
    || typeof target.container !== "string"
    || typeof target.endpoint !== "string"
    || typeof target.revision !== "string"
    || !/^[0-9a-f]{40}$/.test(target.revision)) {
    throw new Error("The active Viewer release target is invalid.");
  }
  const runtime = target.mcpRuntime;
  if (runtime === undefined) return { root: packageRoot, revision: target.revision, releaseId: null };
  if (!runtime
    || typeof runtime !== "object"
    || runtime.source !== "managed"
    || typeof runtime.releaseId !== "string"
    || !/^[a-z0-9-]+$/.test(runtime.releaseId)
    || typeof runtime.revision !== "string"
    || runtime.revision !== target.revision
    || !/^[0-9a-f]{40}$/.test(runtime.revision)
    || typeof runtime.artifactDigest !== "string"
    || !/^[0-9a-f]{64}$/.test(runtime.artifactDigest)
    || typeof runtime.stagedAt !== "string") {
    throw new Error("The active Viewer release has an invalid MCP runtime identity.");
  }
  const releasesRoot = join(stateDir, "mcp-runtime", "releases");
  const releaseRoot = join(releasesRoot, runtime.releaseId);
  const bundle = join(releaseRoot, "dist", "mcp-server.mjs");
  let bundled;
  try {
    bundled = readFileSync(bundle);
  } catch (error) {
    /* A published target with no bundle is a temporary release gap. Keep the
       session's stdio pipe and ask the caller to retry. */
    if (error?.code === "ENOENT") throw new Error("The published MCP runtime is temporarily unavailable; retry the call.");
    throw new Error(`Could not read the published MCP runtime bundle: ${error instanceof Error ? error.message : String(error)}`);
  }
  const artifactDigest = createHash("sha256").update(bundled).digest("hex");
  if (artifactDigest !== runtime.artifactDigest) {
    throw new Error("MCP runtime bundle digest does not match the active release.");
  }
  return { root: releaseRoot, revision: target.revision, releaseId: runtime.releaseId };
}

let cachedTargetSignature = null;
let cachedRuntime = null;
function selectedRuntime() {
  let signature;
  try {
    const target = statSync(targetFile);
    signature = `${target.dev}:${target.ino}:${target.size}:${target.mtimeMs}`;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    signature = "absent";
  }
  if (signature === cachedTargetSignature && cachedRuntime && existsSync(cachedRuntime.entry)) return cachedRuntime;
  const selected = deployedPackageRoot();
  const root = typeof selected === "string" ? selected : selected.root;
  const bundled = join(root, "dist", "mcp-server.mjs");
  const source = join(root, "src", "lib", "mcp", "entry.ts");
  const runtime = {
    root,
    revision: typeof selected === "string" ? null : selected.revision,
    releaseId: typeof selected === "string" ? null : selected.releaseId,
    entry: existsSync(bundled) ? bundled : source,
  };
  cachedTargetSignature = signature;
  cachedRuntime = runtime;
  return runtime;
}

function admissionStdio() {
  let admissionChannel = false;
  try {
    admissionChannel = fstatSync(3).isSocket();
  } catch {
    admissionChannel = false;
  }
  return admissionChannel ? ["pipe", "pipe", 2, 3] : ["pipe", "pipe", 2, "ignore"];
}

const bunRuntime = viewerServerBunRuntime();
let child = null;
let childKey = null;
let nextStartAt = 0;
let retryDelayMs = 200;
let restartTimer = null;
let initialization = null;
let initialized = null;
let replayId = null;
let toolsList = null;
const pending = new Map();
let closing = false;

function reply(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function unavailable(request, detail = "Viewer MCP is reconnecting after a release change") {
  if (request.id === undefined || request.id === null) return;
  if (request.method === "tools/list" && toolsList) {
    reply({ jsonrpc: "2.0", id: request.id, result: toolsList });
  } else if (request.method === "tools/call") {
    reply({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: `${detail}; retry this tool call shortly.` }], isError: true } });
  } else {
    reply({ jsonrpc: "2.0", id: request.id, error: { code: -32002, message: `${detail}; retry shortly.` } });
  }
}
function scheduleRestart() {
  if (closing) return;
  if (restartTimer) clearTimeout(restartTimer);
  const delay = retryDelayMs;
  nextStartAt = Date.now() + delay;
  retryDelayMs = Math.min(delay * 2, 5_000);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    const error = ensureChild();
    if (error) scheduleRestart();
  }, delay);
}
function disconnect(current, detail) {
  if (child !== current) return;
  child = null;
  childKey = null;
  ready = false;
  unreadySince ??= new Date().toISOString();
  for (const request of pending.values()) unavailable(request, detail);
  pending.clear();
  scheduleRestart();
  heartbeat();
}
function start(selected) {
  const env = { ...process.env };
  if (selected.revision) env.LLV_HOT_STATE_RELEASE_REVISION = selected.revision;
  const current = spawn(bunRuntime, [selected.entry], viewerChildProcessOptions({ cwd: selected.root, env, stdio: admissionStdio() }));
  child = current;
  childKey = `${selected.root}\0${selected.revision}`;
  activeReleaseId = selected.releaseId;
  ready = !initialization;
  if (ready) unreadySince = null;
  if (initialization) {
    replayId = `llv-reinitialize-${process.pid}-${Date.now()}`;
    current.stdin.write(`${JSON.stringify({ ...initialization, id: replayId })}\n`);
  }
  createInterface({ input: current.stdout }).on("line", (line) => {
    if (child !== current) return;
    let message;
    try { message = JSON.parse(line); } catch { process.stdout.write(`${line}\n`); return; }
    if (message.id === replayId) {
      replayId = null;
      if (message.result) {
        ready = true;
        unreadySince = null;
        retryDelayMs = 200;
        if (initialized) current.stdin.write(`${JSON.stringify(initialized)}\n`);
        reply({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      } else disconnect(current, "Viewer MCP initialization failed");
      heartbeat();
      return;
    }
    const request = pending.get(JSON.stringify(message.id));
    if (request) {
      pending.delete(JSON.stringify(message.id));
      if (request.method === "tools/list" && message.result) toolsList = message.result;
      if (request.method === "tools/call") {
        if (message.result && !message.result.isError) { lastSuccessfulCallAt = new Date().toISOString(); failedCalls = 0; }
        else failedCalls += 1;
        heartbeat();
      }
    }
    process.stdout.write(`${line}\n`);
  });
  current.once("error", (error) => disconnect(current, `Viewer MCP child could not start: ${error.message}`));
  current.once("exit", () => disconnect(current, "Viewer MCP child exited"));
  heartbeat();
}
function ensureChild() {
  let selected;
  try { selected = selectedRuntime(); }
  catch (error) {
    if (child) {
      const old = child;
      disconnect(old, "Viewer MCP release target is unreadable");
      old.kill("SIGTERM");
    }
    return error instanceof Error ? error.message : String(error);
  }
  const key = `${selected.root}\0${selected.revision}`;
  if (child && childKey !== key) {
    const old = child;
    disconnect(old, "Viewer MCP release changed");
    old.kill("SIGTERM");
    nextStartAt = 0;
  }
  if (!child && Date.now() >= nextStartAt) {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    start(selected);
  }
  return null;
}
createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { request = null; }
  if (request?.method === "initialize") initialization = request;
  if (request?.method === "notifications/initialized") initialized = request;
  const error = ensureChild();
  if (error || !child || !ready) {
    if (request) unavailable(request, error || "Viewer MCP child is starting");
    return;
  }
  if (request?.id !== undefined && request?.id !== null) pending.set(JSON.stringify(request.id), request);
  child.stdin.write(`${line}\n`);
}).on("close", () => {
  closing = true;
  clearInterval(heartbeatTimer);
  if (restartTimer) clearTimeout(restartTimer);
  if (child) child.stdin.end();
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  closing = true;
  clearInterval(heartbeatTimer);
  if (restartTimer) clearTimeout(restartTimer);
  if (child) child.kill(signal);
  else process.exit(0);
});
process.on("beforeExit", () => {
  if (!heartbeatPath) return;
  try {
    const current = JSON.parse(readFileSync(heartbeatPath, "utf8"));
    if (current.pid === process.pid && current.startedAt === startedAt) unlinkSync(heartbeatPath);
  } catch { /* A newer process owns this record or it was already removed. */ }
});
const initialError = ensureChild();
if (initialError) {
  console.error(initialError);
  process.exitCode = 1;
  process.stdin.destroy();
}
