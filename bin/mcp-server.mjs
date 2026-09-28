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
  cliRuntimeHostConfig,
  discardWakatimeEnvironmentCredential,
  viewerChildProcessOptions,
  viewerServerBunRuntime,
} from "./server-runtime.mjs";
import { installedRelease, isGitCheckout, selfUpdatePaths } from "./self-update-supervisor.mjs";

discardWakatimeEnvironmentCredential();
process.env.LLV_STATE_OWNER = "mcp";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = process.env.LLV_STATE_DIR || join(appDirIn(process.env.XDG_CONFIG_HOME || join(homedir(), ".config")), "state");
const targetFile = process.env.LLV_VIEWER_DEPLOY_TARGET || join(stateDir, "viewer-release.json");
const selfUpdateConfig = isGitCheckout(packageRoot) ? cliRuntimeHostConfig(packageRoot) : null;
const selfUpdatePointer = selfUpdateConfig
  ? selfUpdatePaths({
      stateDirectory: selfUpdateConfig.stateDirectory,
      cacheDirectory: process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"),
      installId: selfUpdateConfig.installId,
    }).releasePointer
  : null;
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
let transportUnverified = false;

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
    if (error?.code === "ENOENT") return null;
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
    if (error?.code === "ENOENT") {
      const gap = new Error("The published MCP runtime is temporarily unavailable; retry the call.");
      gap.recoverable = true;
      throw gap;
    }
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
function fileSignature(file) {
  if (!file) return "absent";
  try {
    const stat = statSync(file);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return "absent";
  }
}
function selectedRuntime() {
  const signature = `${fileSignature(targetFile)}\0${fileSignature(selfUpdatePointer)}`;
  /* Recheck the bundle digest before every new child. A cached selection is
     safe only while its already-verified child is still the one running. */
  if (child && signature === cachedTargetSignature && cachedRuntime && existsSync(cachedRuntime.entry)) return cachedRuntime;
  const selected = deployedPackageRoot() ?? {
    root: selfUpdatePointer ? installedRelease(selfUpdatePointer, packageRoot).dir : packageRoot,
    revision: null,
    releaseId: null,
  };
  const root = selected.root;
  const bundled = join(root, "dist", "mcp-server.mjs");
  const source = join(root, "src", "lib", "mcp", "entry.ts");
  const runtime = {
    root,
    revision: selected.revision,
    releaseId: selected.releaseId,
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
let initializationComplete = false;
let initialized = null;
let replayId = null;
let toolsList = null;
const pending = new Map();
let closing = false;
let shutdownSignal = null;
let protocolProbe = null;
let protocolProbeTimer = null;
let initializationTimer = null;
const PROTOCOL_PROBE_INTERVAL_MS = 30_000;
const PROTOCOL_PROBE_TIMEOUT_MS = 10_000;

function transportFailure(result, protocolError) {
  const verdict = result?.structuredContent;
  if (verdict?.ok === false && (verdict.code === "tool_failed" || verdict.code === "outcome_unknown")) {
    const reason = typeof verdict.error === "string" ? verdict.error : "";
    if (/^Viewer control (?:is unreachable|did not reconnect|dispatch timed out)/.test(reason)
      || (verdict.code === "outcome_unknown" && /(?:connection was refused|connection failed|Viewer did not answer)/.test(reason))) return true;
  }
  const text = [protocolError?.message, ...(Array.isArray(result?.content) ? result.content.map((item) => item?.text) : [])]
    .filter((part) => typeof part === "string").join(" ");
  return (result?.isError === true || protocolError)
    && /(?:ECONNREFUSED|Viewer control (?:is unreachable|did not reconnect|dispatch timed out)|MCP server viewer is not connected)/.test(text);
}

function probeProtocol(current) {
  if (child !== current || !ready || protocolProbe) return;
  const id = `llv-probe-${process.pid}-${Date.now()}`;
  const timer = setTimeout(() => {
    disconnect(current, "Viewer MCP child stopped responding");
    current.kill("SIGTERM");
  }, PROTOCOL_PROBE_TIMEOUT_MS);
  protocolProbe = { id, timer };
  writeChild(current, `${JSON.stringify({ jsonrpc: "2.0", id, method: "ping" })}\n`);
}

function writeChild(current, line) {
  if (child !== current) return;
  try {
    current.stdin.write(line);
  } catch (error) {
    disconnect(current, `Viewer MCP child pipe failed: ${error instanceof Error ? error.message : String(error)}`);
    current.kill("SIGTERM");
  }
}

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
function finishSignalShutdown() {
  if (!shutdownSignal || child) return;
  input.close();
  process.stdin.destroy();
  process.stdout.end();
}
function disconnect(current, detail, planned = false) {
  if (child !== current) return;
  if (protocolProbe) clearTimeout(protocolProbe.timer);
  protocolProbe = null;
  if (initializationTimer) clearTimeout(initializationTimer);
  initializationTimer = null;
  child = null;
  childKey = null;
  ready = false;
  if (!planned) transportUnverified = true;
  unreadySince ??= new Date().toISOString();
  const interrupted = [...pending.values()];
  for (const request of interrupted) {
    if (request.method === "tools/call") {
      failedCalls += 1;
      transportUnverified = true;
    }
  }
  pending.clear();
  scheduleRestart();
  heartbeat();
  for (const request of interrupted) if (request.method !== "initialize") unavailable(request, detail);
  finishSignalShutdown();
}
function sendInitialization(current) {
  if (!initialization || replayId !== null) return;
  replayId = initializationComplete ? `llv-reinitialize-${process.pid}-${Date.now()}` : initialization.id;
  writeChild(current, `${JSON.stringify({ ...initialization, id: replayId })}\n`);
  if (child !== current) return;
  initializationTimer = setTimeout(() => {
    disconnect(current, "Viewer MCP initialization timed out");
    current.kill("SIGTERM");
  }, 30_000);
}
function start(selected) {
  const env = { ...process.env };
  if (selected.revision) env.LLV_HOT_STATE_RELEASE_REVISION = selected.revision;
  const current = spawn(bunRuntime, [selected.entry], viewerChildProcessOptions({ cwd: selected.root, env, stdio: admissionStdio() }));
  child = current;
  childKey = `${selected.root}\0${selected.revision}`;
  activeReleaseId = selected.releaseId;
  ready = false;
  replayId = null;
  current.once("error", (error) => disconnect(current, `Viewer MCP child could not start: ${error.message}`));
  current.once("exit", () => disconnect(current, "Viewer MCP child exited"));
  current.stdin.on("error", (error) => {
    if (child !== current) return;
    disconnect(current, `Viewer MCP child pipe failed: ${error.message}`);
    current.kill("SIGTERM");
  });
  sendInitialization(current);
  createInterface({ input: current.stdout }).on("line", (line) => {
    if (child !== current) return;
    let message;
    try { message = JSON.parse(line); } catch { process.stdout.write(`${line}\n`); return; }
    if (protocolProbe && message.id === protocolProbe.id) {
      clearTimeout(protocolProbe.timer);
      protocolProbe = null;
      if (message.error) {
        disconnect(current, "Viewer MCP child rejected its protocol probe");
        current.kill("SIGTERM");
      }
      return;
    }
    if (message.id === replayId) {
      replayId = null;
      if (initializationTimer) clearTimeout(initializationTimer);
      initializationTimer = null;
      if (message.result) {
        if (!initializationComplete) {
          initializationComplete = true;
          reply(message);
        }
        ready = true;
        if (!transportUnverified) unreadySince = null;
        retryDelayMs = 200;
        if (initialized) writeChild(current, `${JSON.stringify(initialized)}\n`);
        if (child !== current) return;
        reply({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      } else {
        disconnect(current, "Viewer MCP initialization failed");
        current.kill("SIGTERM");
      }
      heartbeat();
      return;
    }
    const request = pending.get(JSON.stringify(message.id));
    if (request) {
      pending.delete(JSON.stringify(message.id));
      if (request.method === "tools/list" && message.result) toolsList = message.result;
      if (request.method === "tools/call") {
        if (transportFailure(message.result, message.error)) failedCalls += 1;
        else if (message.result && !message.result.isError) {
          lastSuccessfulCallAt = new Date().toISOString();
          failedCalls = 0;
          transportUnverified = false;
          unreadySince = null;
        } else if (message.result?.structuredContent?.ok === false) {
          failedCalls = 0;
          transportUnverified = false;
          unreadySince = null;
        }
        heartbeat();
      }
    }
    process.stdout.write(`${line}\n`);
  });
  if (!protocolProbeTimer) {
    protocolProbeTimer = setInterval(() => { if (child) probeProtocol(child); }, PROTOCOL_PROBE_INTERVAL_MS);
    protocolProbeTimer.unref();
  }
  heartbeat();
}
function ensureChild() {
  if (closing) return { message: "Viewer MCP launcher is shutting down" };
  let selected;
  try { selected = selectedRuntime(); }
  catch (error) {
    if (child) {
      const old = child;
      disconnect(old, "Viewer MCP release target is unreadable");
      old.kill("SIGTERM");
    }
    return { message: error instanceof Error ? error.message : String(error), recoverable: error?.recoverable === true };
  }
  const key = `${selected.root}\0${selected.revision}`;
  if (child && childKey !== key) {
    const old = child;
    disconnect(old, "Viewer MCP release changed", true);
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
const input = createInterface({ input: process.stdin }).on("line", (line) => {
  if (closing) return;
  let request;
  try { request = JSON.parse(line); } catch { request = null; }
  if (request?.method === "initialize") initialization = request;
  if (request?.method === "notifications/initialized") initialized = request;
  const error = ensureChild();
  if (request?.method === "initialize") {
    if (!error && child) {
      if (!ready) sendInitialization(child);
      else {
        pending.set(JSON.stringify(request.id), request);
        writeChild(child, `${line}\n`);
      }
    }
    return;
  }
  /* Installed launcher consumers that do not speak MCP still get their
     original byte stream. This does not claim protocol readiness. */
  if (!initialization && !error && child) {
    writeChild(child, `${line}\n`);
    return;
  }
  if (error || !child || !ready) {
    if (request) unavailable(request, error?.message || "Viewer MCP child is starting");
    return;
  }
  if (request?.id !== undefined && request?.id !== null) pending.set(JSON.stringify(request.id), request);
  writeChild(child, `${line}\n`);
}).on("close", () => {
  closing = true;
  clearInterval(heartbeatTimer);
  if (protocolProbeTimer) clearInterval(protocolProbeTimer);
  if (restartTimer) clearTimeout(restartTimer);
  if (child) child.stdin.end();
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  closing = true;
  shutdownSignal = signal;
  clearInterval(heartbeatTimer);
  if (protocolProbeTimer) clearInterval(protocolProbeTimer);
  if (restartTimer) clearTimeout(restartTimer);
  if (child) child.kill(signal);
  else finishSignalShutdown();
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
  console.error(initialError.message);
  if (initialError.recoverable) scheduleRestart();
  else {
    process.exitCode = 1;
    process.stdin.destroy();
  }
}
