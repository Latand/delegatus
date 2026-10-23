import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stateDir } from "@/lib/configDir";
import { endLeasedHelper, leasedHelperInput, spawnLeasedHelper } from "@/lib/helperLease";
import { performanceSpans } from "@/lib/performanceSpans";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { voiceToolBounds, type SecretPolicies, type ProbeResult, type VoiceToolServer } from "./contracts";
import { VoiceToolsError, VoiceToolsStore } from "./store";

/** Allowlist rather than inherited credentials; each server has a private HOME. */
export function voiceToolEnvironment(home: string, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { NODE_ENV: "production", HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"), TMPDIR: home };
  for (const name of ["PATH", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR", "PATHEXT"]) if (source[name]) result[name] = source[name];
  return result;
}
/**
 * A probe launcher as an absolute file found on the Viewer's own PATH. Relative PATH entries are
 * skipped, and nothing a proposal sets takes part, so the binary that starts is the one named here.
 */
export async function resolveExecutable(command: "bun" | "uv", searchPath = process.env.PATH ?? ""): Promise<string | null> {
  for (const directory of searchPath.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, command);
    try {
      if (!(await fs.stat(candidate)).isFile()) continue;
      await fs.access(candidate, constants.X_OK);
      return candidate;
    } catch { continue; }
  }
  return null;
}
async function launch() {
  const exists = async (file: string) => fs.access(file).then(() => true, () => false);
  const source = path.join(process.cwd(), "src/lib/voiceTools/probe.worker.ts");
  return { executable: await exists("/usr/local/bin/bun-container") ? "/usr/local/bin/bun-container" : process.versions.bun ? process.execPath : process.env.LLV_BUN_EXECUTABLE || "bun",
    worker: await exists(source) ? source : path.join(process.cwd(), ".next/server/voice-tools-probe-worker.js") };
}
export class VoiceToolHub {
  private active = 0;
  constructor(readonly store: VoiceToolsStore, private deadlineMs: number = voiceToolBounds.deadlineMs,
    private schedule: (callback: () => void, milliseconds: number) => () => void = (callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer);
    }) {}
  async dryRun(name: string, expected: string, signal?: AbortSignal, authorize?: () => void): Promise<void> {
    if (this.active >= voiceToolBounds.children) throw new VoiceToolsError("BUSY");
    if (signal?.aborted) throw new VoiceToolsError("CANCELLED");
    this.active++;
    const deadline = new AbortController();
    // The lease reserves 1.5 s for TERM and 1 s for KILL/reaping. Keep that
    // shutdown inside the 20 s budget rather than granting it after expiry.
    const dispose = this.schedule(() => deadline.abort(new VoiceToolsError("TIMEOUT")), Math.max(1, this.deadlineMs - 3000));
    const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    let disposeCutoff!: () => void;
    const cutoff = new Promise<never>((_, reject) => {
      disposeCutoff = this.schedule(() => {
        deadline.abort(new VoiceToolsError("TIMEOUT"));
        reject(new VoiceToolsError(signal?.aborted ? "CANCELLED" : "TIMEOUT"));
      }, this.deadlineMs);
    });
    // The shared file transaction can outlast this request's deadline. Its
    // read-only preparation may finish later, but the aborted signal prevents
    // dispatch and the slot stays occupied until all owned work has settled.
    const work = withViewerOperation("voice-tools.catalog", () => performanceSpans.wait("voice-tools.catalog", async () => {
      let result: ProbeResult;
      try {
        const input = await this.store.probeInput(name, expected);
        result = await this.probe(name, expected, input.server, input.secrets, combined, authorize);
      } catch (error) {
        if (!(error instanceof VoiceToolsError) || error.code !== "MISSING_SECRET") throw error;
        result = { code: "MISSING_SECRET" };
      }
      await this.store.recordProbe(name, expected, result);
    })).finally(() => { this.active--; });
    try {
      await Promise.race([work, cutoff]);
    } finally { dispose(); disposeCutoff(); }
  }
  private async probe(name: string, expected: string, server: VoiceToolServer, secrets: Record<string, string>, signal?: AbortSignal, authorize?: () => void): Promise<ProbeResult> {
    const abortCode = () => signal?.reason instanceof VoiceToolsError && signal.reason.code === "TIMEOUT" ? "TIMEOUT" as const : "CANCELLED" as const;
    if (signal?.aborted) return { code: abortCode() };
    const home = path.join(this.store.directory, "voice-tools-data", name);
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    const executable = await launch();
    // A stdio launch gets a fresh Viewer-owned folder: an empty Bun config for --config, and an empty
    // working folder for package launchers. It sits outside every server's private home, so no
    // server can plant a node_modules/.bin above it, and it is removed once the helper has closed.
    const runRoot = path.join(this.store.directory, "voice-tools-runs", randomUUID());
    try {
      let policies: SecretPolicies = {};
      let stdio: { executable: string; config: string; runDir: string; runRoot: string; stateDirectory: string } | undefined;
      if (server.transport.type === "stdio") {
        const resolved = await resolveExecutable(server.transport.command);
        if (!resolved) return { code: "START_FAILED" };
        await fs.mkdir(path.join(runRoot, "cwd"), { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(runRoot, "config.toml"), "", { mode: 0o600, flag: "wx" });
        stdio = { executable: resolved, config: path.join(runRoot, "config.toml"), runDir: path.join(runRoot, "cwd"), runRoot,
          stateDirectory: await fs.realpath(this.store.directory) };
      }
      // Preparation awaited disk I/O; resolve the exact proposal again at dispatch.
      const current = await this.store.probeInput(name, expected);
      server = current.server; secrets = current.secrets; policies = current.policies;
      if (server.transport.type === "stdio" && !stdio) return { code: "START_FAILED" };
      authorize?.();
      if (signal?.aborted) return { code: abortCode() };
      return await this.spawnProbe(name, home, executable, server, secrets, policies, stdio, signal, abortCode);
    } finally { await fs.rm(runRoot, { recursive: true, force: true }); }
  }
  private spawnProbe(name: string, home: string, executable: { executable: string; worker: string }, server: VoiceToolServer, secrets: Record<string, string>, policies: SecretPolicies,
    stdio: { executable: string; config: string; runDir: string; runRoot: string; stateDirectory: string } | undefined, signal: AbortSignal | undefined, abortCode: () => "TIMEOUT" | "CANCELLED"): Promise<ProbeResult> {
    return performanceSpans.wait("voice-tools.spawn", () => new Promise<ProbeResult>(resolve => {
      const child = spawnLeasedHelper("voice-tools-probe", { command: executable.executable, args: [executable.worker],
        cwd: process.cwd(), env: voiceToolEnvironment(home, process.env) }, this.store.directory, { input: true, stdout: "pipe", stderr: "ignore" });
      const chunks: Buffer[] = [];
      let bytes = 0, result: ProbeResult | undefined;
      const stop = (code: ProbeResult["code"]) => { result ??= { code }; endLeasedHelper(child); };
      const abort = () => stop(abortCode());
      signal?.addEventListener("abort", abort, { once: true });
      const finish = () => {
        signal?.removeEventListener("abort", abort);
        if (!result) {
          try {
            const raw = Buffer.concat(chunks).toString("utf8");
            if (Object.values(secrets).some(secret => raw.includes(secret) || raw.includes(JSON.stringify(secret).slice(1, -1)))) result = { code: "SECRET_ECHO" };
            else {
              const parsed = JSON.parse(raw) as ProbeResult;
              result = ["OK", "START_FAILED", "PROTOCOL_ERROR", "CATALOG_BOUNDS", "SECRET_ECHO", "SECRET_DESTINATION", "ENTRY_CHANGED"].includes(parsed.code) ? parsed : { code: "PROTOCOL_ERROR" };
            }
          } catch { result = { code: "START_FAILED" }; }
        }
        resolve(result);
      };
      child.once("close", finish);
      child.once("error", () => { result = { code: "START_FAILED" }; });
      child.stdout?.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > voiceToolBounds.wireBytes) { stop("CATALOG_BOUNDS"); return; }
        chunks.push(chunk);
      });
      child.stdout?.on("error", () => stop("PROTOCOL_ERROR"));
      const input = leasedHelperInput(child);
      input.on("error", () => stop("START_FAILED"));
      // Secrets cross an owned pipe only, never argv, logs or the helper record.
      input.end(JSON.stringify({ name, server, secrets, policies, home, launch: stdio ?? null }));
      if (signal?.aborted) abort();
    }));
  }
}
const shared = globalThis as typeof globalThis & { __voiceToolHub?: VoiceToolHub };
export function voiceToolHub(): VoiceToolHub {
  return shared.__voiceToolHub ??= new VoiceToolHub(new VoiceToolsStore(stateDir()));
}
export function setVoiceToolHubForTests(hub: VoiceToolHub | undefined): void { shared.__voiceToolHub = hub; }
