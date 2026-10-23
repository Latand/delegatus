import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { CodexPinnedProtocol, resolveCodexProtocol } from "@/lib/accounts/codexPinnedProtocol";
import { signalDetachedProcessGroup } from "@/lib/processGroup";
import { CodexUpdateProbeFailure, type UpdatePorts } from "./update";
import { writeJsonDurably } from "@/lib/state/durableJson";

/** Bounded children, bounded captured output, and a credential-free environment. */
export class UpdateCommandFailure extends Error {
  constructor(message: string, readonly diagnostics: string) { super(message); }
}

function groupHasRunningProcesses(groupId: number): boolean | null {
  if (process.platform === "linux") {
    let entries: string[];
    try { entries = fs.readdirSync("/proc"); } catch { return null; }
    let uncertain = false;
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
        if (Number(fields[2]) === groupId && fields[0] !== "Z" && fields[0] !== "X" && fields[0] !== "x") return true;
      } catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) uncertain = true; }
    }
    return uncertain ? null : false;
  }
  if (process.platform === "win32") return null;
  try { process.kill(-groupId, 0); return true; }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? true
      : (error as NodeJS.ErrnoException).code === "ESRCH" ? false : null;
  }
}

async function stopAndVerifyGroup(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid) return;
  signalDetachedProcessGroup(child, "SIGKILL");
  const deadline = Date.now() + 5_000;
  for (;;) {
    const running = groupHasRunningProcesses(child.pid);
    if (running === false) return;
    if (Date.now() >= deadline) throw new Error("could not verify failed command process group stopped");
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
}

export function runUpdateCommand(binary: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, cwd?: string,
  beforeDeadline?: (pid: number) => Promise<void>): Promise<string> {
  if (beforeDeadline && process.env.NODE_ENV !== "test") throw new Error("command readiness seam is test-only");
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", diagnostic = "", bytes = 0, failure: Error | undefined, closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { failure ??= new Error("command deadline or output bound"); signalDetachedProcessGroup(child, "SIGKILL"); };
    if (beforeDeadline && child.pid) {
      void beforeDeadline(child.pid).then(() => { if (!failure && !closed) timer = setTimeout(stop, timeoutMs); }, error => {
        failure ??= error instanceof Error ? error : new Error(String(error));
        signalDetachedProcessGroup(child, "SIGKILL");
      });
    } else timer = setTimeout(stop, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) stop(); else output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; diagnostic = (diagnostic + chunk.toString()).slice(-16 * 1024); if (bytes > 16 * 1024 * 1024) stop(); });
    child.once("error", () => { failure ??= new Error("command could not start"); });
    child.once("close", async code => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (failure || code !== 0) {
        try { await stopAndVerifyGroup(child); }
        catch (error) { reject(new UpdateCommandFailure(`${failure?.message ?? `command exit ${code}`}; ${error instanceof Error ? error.message : "group cleanup failed"}`, diagnostic)); return; }
        reject(new UpdateCommandFailure(failure?.message ?? `command exit ${code}`, diagnostic));
      } else resolve(output);
    });
  });
}

export function codexProcessesPresent(output: string): boolean {
  if (!output.trim()) throw new Error("empty process inventory");
  // Includes all roles, idle app-servers, native subagents and npm wrapper children.
  // A shell prompt containing the word codex never counts as a process identity.
  return output.split("\n").some(line => {
    if (!line.trim()) return false;
    const [state = "", comm = "", executable = "", script = ""] = line.trim().split(/\s+/);
    if (!/^[RSDZTWXIKtU][A-Za-z+<>0-9-]*$/.test(state) || !comm) throw new Error("unreadable process inventory");
    if (state.startsWith("Z") || state.startsWith("X")) return false;
    return /^codex(?:$|[-.])/.test(path.basename(comm))
      || /(?:^|[/\\])codex(?:\.exe)?$/.test(executable)
      || /(?:^|[/\\])codex\.js$/.test(script);
  });
}

export function productionUpdatePorts(options: {
  bun: string; probeFile: string; scratch: string;
  current: () => boolean; report: UpdatePorts["report"];
  versionsDirectory?: string;
}): UpdatePorts {
  const env: NodeJS.ProcessEnv = { PATH: [path.dirname(options.bun), "/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter), LANG: "C.UTF-8", NODE_ENV: "test" };
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "CODEX_HOME", "LLV_STATE_DIR", "TMPDIR"]) {
    env[key] = path.join(options.scratch, key.toLowerCase());
    fs.mkdirSync(env[key]!, { recursive: true, mode: 0o700 });
  }
  const version = async (binary: string) => {
    const value = await runUpdateCommand(binary, ["--version"], env, 5_000);
    const match = /^codex-cli (\d+\.\d+\.\d+)\s*$/.exec(value);
    if (!match) throw new Error("unidentified CLI version");
    return match[1]!;
  };
  return {
    now: Date.now, current: options.current, report: options.report, version,
    compatibilityKey: () => createHash("sha256").update(process.env.LLV_HOT_STATE_RELEASE_REVISION ?? "")
      .update(new CodexPinnedProtocol().schemaDigest).update(fs.readFileSync(options.probeFile)).digest("hex"),
    latest: async () => {
      const response = await fetch("https://registry.npmjs.org/@openai%2fcodex/latest", { signal: AbortSignal.timeout(10_000), redirect: "error" });
      if (!response.ok) throw new Error("registry request failed");
      // Registry bodies are bounded before parsing, even without Content-Length.
      const reader = response.body!.getReader(); let body = "", bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.length; if (bytes > 1024 * 1024) throw new Error("registry body too large");
          body += new TextDecoder().decode(chunk.value, { stream: true });
        }
      } finally { await reader.cancel(); }
      const row = JSON.parse(body);
      if (row.name !== "@openai/codex" || !/^\d+\.\d+\.\d+$/.test(row.version)) throw new Error("invalid registry version");
      return row.version;
    },
    install: async (release, directory) => {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      // Every attempt owns a new prefix; a failed attempt never rewrites a retained version.
      const prefix = path.join(directory, `${release}-${randomUUID()}`);
      const manifest = path.join(directory, "owned.json");
      let owned: string[] = [];
      try { owned = JSON.parse(fs.readFileSync(manifest, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!Array.isArray(owned) || !owned.every(item => typeof item === "string" && path.dirname(item) === directory)) throw new Error("invalid owned prefix manifest");
      // Record the exact owned name BEFORE creating anything to recover crashes.
      writeJsonDurably(manifest, [...owned, prefix]);
      fs.mkdirSync(prefix, { mode: 0o700 });
      fs.writeFileSync(path.join(prefix, "package.json"), JSON.stringify({ private: true, dependencies: { "@openai/codex": release } }));
      try {
        await runUpdateCommand(options.bun, ["install", "--cwd", prefix, "--ignore-scripts", "--no-progress", "--registry", "https://registry.npmjs.org"], env, 120_000);
        return path.join(prefix, "node_modules/@openai/codex/bin/codex.js");
      } catch (error) { fs.rmSync(prefix, { recursive: true, force: true }); throw error; }
    },
    prune: async keep => {
      const directory = options.versionsDirectory;
      if (!directory) return;
      const manifest = path.join(directory, "owned.json");
      let owned: string[];
      try { owned = JSON.parse(fs.readFileSync(manifest, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      if (!Array.isArray(owned) || !owned.every(item => typeof item === "string" && path.dirname(item) === directory)) throw new Error("invalid owned prefix manifest");
      const retained: string[] = [];
      for (const prefix of owned) {
        if (keep.some(target => target.startsWith(`${prefix}${path.sep}`))) retained.push(prefix);
        else fs.rmSync(prefix, { recursive: true, force: true });
      }
      if (retained.length !== owned.length) writeJsonDurably(manifest, retained);
    },
    probe: async (release, binary) => {
      try {
        const protocol = await resolveCodexProtocol(release, binary, env);
        protocol.initializeCapabilities(["thread/queue/list", "thread/realtime/start", "thread/start", "turn/start", "account/read", "account/rateLimits/read"]);
      } catch { throw new CodexUpdateProbeFailure("app-server schema"); }
      // Exactly the native adapter fixture that CI runs, bundled for package installs.
      try { await runUpdateCommand(options.bun, ["test", "--timeout=60000", options.probeFile], {
        ...env, NODE_ENV: "test", NATIVE_CODEX_QUEUE_TEST_BINARY: binary,
        LLV_CODEX_BINARY: binary, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1",
      }, 90_000, options.scratch); } catch (error) { throw new CodexUpdateProbeFailure("native queue fixture", error); }
    },
    idle: async () => {
      if (os.platform() === "win32") throw new Error("process inventory unavailable");
      return !codexProcessesPresent(await runUpdateCommand("ps", ["-A", "-o", "stat=", "-o", "comm=", "-o", "args="], env, 5_000));
    },
  };
}
