// @ts-check
import { constants } from "node:fs";
import { access, lstat, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { agentBinaryCandidates } from "./agent-binaries.mjs";

/** @typedef {import('../src/lib/doctor/contracts').DoctorHost} DoctorHost */
/** @typedef {import('../src/lib/doctor/contracts').CapabilityStatus} CapabilityStatus */
/** @typedef {import('../src/lib/doctor/contracts').CapabilityReport} CapabilityReport */
/** @typedef {import('../src/lib/doctor/contracts').Inspection} Inspection */
/** @typedef {(signal: AbortSignal) => Promise<[CapabilityStatus['state'], CapabilityStatus['reason']]>} Probe */

export const DOCTOR_PROBE_TIMEOUT_MS = 1500;

/** No file contents, executable output, paths or environment values enter a report.
 * @param {string} file
 * @param {'directory' | 'real-directory' | 'credential' | 'executable'} kind
 * @param {AbortSignal} [signal]
 * @returns {Promise<Inspection>}
 */
async function inspect(file, kind, signal) {
  try {
    signal?.throwIfAborted();
    const info = await (kind === "real-directory" ? lstat(file) : stat(file));
    signal?.throwIfAborted();
    if (kind === "real-directory" && info.isSymbolicLink()) return "absent";
    if (kind === "directory" || kind === "real-directory" ? !info.isDirectory() : !info.isFile()) return "unreadable";
    if (kind === "credential" && info.size === 0) return "absent";
    await access(file, kind === "executable" && process.platform !== "win32" ? constants.X_OK : constants.R_OK);
    return "present";
  } catch (error) {
    return ["ENOENT", "ENOTDIR"].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? "") ? "absent" : "unreadable";
  }
}

/** @returns {DoctorHost} */
export function doctorHost() {
  return {
    home: homedir(), platform: process.platform, arch: process.arch, env: process.env,
    now: Date.now, inspect,
    async viewer(port, signal) {
      // Fixed loopback, no credentials and no redirect following. HEAD runs no probes.
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/onboarding/diagnostics`, {
          method: "HEAD", redirect: "manual", signal,
        });
        await response.body?.cancel();
        if (response.status === 204 && response.headers.get("x-delegatus-diagnostics") === "1") return "reachable";
        if ([401, 403].includes(response.status)) return "auth-required";
        return "unrecognized";
      } catch {
        if (signal.aborted) throw signal.reason;
        return "unreachable";
      }
    },
  };
}

/** Matches the local transcription reader's app-directory and former-cache fallback.
 * Does no migration, directory creation or warning output.
 * @param {DoctorHost} host
 * @param {AbortSignal} [signal]
 */
export async function doctorWhisperPython(host, signal) {
  signal?.throwIfAborted();
  if (host.env.LLV_WHISPER_VENV) return path.join(host.env.LLV_WHISPER_VENV, "bin", "python");
  const root = host.env.XDG_CACHE_HOME || path.join(host.home, ".cache");
  const current = path.join(root, "delegatus");
  const legacy = path.join(root, "agent-log-viewer");
  const currentState = await host.inspect(current, "real-directory", signal);
  signal?.throwIfAborted();
  if (currentState === "unreadable") throw new Error("cache unreadable");
  const legacyState = currentState === "present" ? "absent" : await host.inspect(legacy, "directory", signal);
  signal?.throwIfAborted();
  if (legacyState === "unreadable") throw new Error("cache unreadable");
  const preferred = currentState === "present" ? current : legacyState === "present" ? legacy : current;
  for (const dir of [preferred, path.join(root, "live-log-viewer")]) {
    const entry = path.join(dir, "whisper-venv");
    const result = await host.inspect(entry, "directory", signal);
    signal?.throwIfAborted();
    if (result === "unreadable") throw new Error("cache unreadable");
    if (result === "present") return path.join(entry, "bin", "python");
  }
  return path.join(preferred, "whisper-venv", "bin", "python");
}

/** @param {DoctorHost} host @param {'claude' | 'codex'} engine @param {AbortSignal} signal */
async function binaryPresence(host, engine, signal) {
  if ((host.env.PATH?.length ?? 0) > 32768) throw new Error("search path exceeds diagnostic bound");
  const candidates = agentBinaryCandidates(engine, { home: host.home, platform: host.platform, envPath: host.env.PATH ?? "" });
  if (host.env.LLV_DOCKER_NSENTER_SHIMS === "1") candidates.unshift(`/usr/local/bin/${engine}`);
  if (engine === "codex" && host.env.LLV_CODEX_BINARY?.trim()) {
    const binary = host.env.LLV_CODEX_BINARY.trim();
    const absolute = path.isAbsolute(binary) || binary.includes("/") || binary.includes("\\");
    candidates.splice(0, candidates.length, ...(absolute ? [binary]
      : (host.env.PATH ?? "").split(host.platform === "win32" ? ";" : ":").filter(Boolean).map(dir => path.join(dir, binary))));
  }
  if (candidates.length > 256) throw new Error("binary candidates exceed diagnostic bound");
  for (const candidate of new Set(candidates)) {
    signal.throwIfAborted();
    const result = await host.inspect(candidate, "executable", signal);
    signal.throwIfAborted();
    if (result === "present") return "present";
    if (result === "unreadable") throw new Error("binary unreadable");
  }
  return "absent";
}

/** @param {number} port */
export function validDoctorPort(port) { return Number.isInteger(port) && port >= 1 && port <= 65535; }

/** The same bounded, read-only registry serves a standalone CLI and onboarding.
 * Every probe runs asynchronously under its own deadline. There is no cache or background loop.
 * @param {import('../src/lib/doctor/contracts').DoctorOptions} [options]
 * @returns {Promise<CapabilityReport>}
 */
export async function runDoctor({ host = doctorHost(), port = 8898 } = {}) {
  if (!validDoctorPort(port)) throw new Error("invalid diagnostic port");
  const generatedAt = new Date(host.now()).toISOString();
  /** @param {'claude' | 'codex'} engine @returns {Probe} */
  const engineProbe = engine => async signal => await binaryPresence(host, engine, signal) === "present"
    ? ["available", null] : ["blocked", "CLI_MISSING"];
  /** @param {'claude' | 'codex'} engine @returns {Probe} */
  const transcriptProbe = engine => async signal => {
    const result = await host.inspect(path.join(host.home, `.${engine}`, engine === "claude" ? "projects" : "sessions"), "directory", signal);
    if (result === "unreadable") throw new Error("transcript source unreadable");
    return result === "present" ? ["available", null] : ["degraded", "TRANSCRIPT_ROOT_MISSING"];
  };
  /** @type {Array<[CapabilityStatus['id'], Probe]>} */
  const probes = [
    ["engine.claude", engineProbe("claude")],
    ["engine.codex", engineProbe("codex")],
    ["auth.codex", async signal => {
      // Deliberately use the same fixed source as readCodexAuth, without reading it.
      const result = await host.inspect(path.join(host.home, ".codex", "auth.json"), "credential", signal);
      if (result === "unreadable") throw new Error("credential source unreadable");
      return result === "present" ? ["available", null] : ["blocked", "AUTH_ABSENT"];
    }],
    ["transcripts.claude", transcriptProbe("claude")],
    ["transcripts.codex", transcriptProbe("codex")],
    ["transcription.local", async signal => {
      const python = await doctorWhisperPython(host, signal);
      signal.throwIfAborted();
      const result = await host.inspect(python, "executable", signal);
      if (result === "unreadable") throw new Error("interpreter unreadable");
      // A Python executable alone proves neither faster-whisper nor a downloaded model.
      return result === "present" ? ["degraded", "WHISPER_RUNTIME_UNCHECKED"] : ["blocked", "WHISPER_VENV_MISSING"];
    }],
    ["viewer.server", async signal => {
      const result = await host.viewer(port, signal);
      if (result === "reachable") return ["available", null];
      if (result === "auth-required") return ["degraded", "VIEWER_AUTH_REQUIRED"];
      if (result === "unrecognized") return ["unknown", "VIEWER_UNRECOGNIZED"];
      return ["blocked", "VIEWER_UNREACHABLE"];
    }],
  ];
  const capabilities = await Promise.all(probes.map(async ([id, probe]) => {
    const start = host.now();
    const controller = new AbortController();
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    /** @type {Promise<never>} */
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("probe deadline")); }, DOCTOR_PROBE_TIMEOUT_MS);
    });
    /** @type {CapabilityStatus['state']} */
    let state;
    /** @type {CapabilityStatus['reason']} */
    let reason;
    try { [state, reason] = await Promise.race([Promise.resolve().then(() => probe(controller.signal)), timeout]); }
    catch { state = "unknown"; reason = controller.signal.aborted ? "PROBE_TIMEOUT" : "PROBE_ERROR"; }
    finally { clearTimeout(timer); }
    return { id, state, reason, probedAt: new Date(start).toISOString(), durationMs: Math.max(0, host.now() - start), timedOut: reason === "PROBE_TIMEOUT" };
  }));
  return { schemaVersion: 1, generatedAt, platform: { os: host.platform, arch: host.arch }, capabilities };
}
