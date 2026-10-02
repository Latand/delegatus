import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Reader = (binary: string, cwd: string, env: NodeJS.ProcessEnv, args: readonly string[]) => unknown;
let testReader: Reader | null = null;

export function setCodexShellPolicyReaderForTest(reader: Reader): () => void {
  if (process.env.NODE_ENV !== "test") throw new Error("Codex shell policy test reader is unavailable");
  const previous = testReader;
  testReader = reader;
  return () => { testReader = previous; };
}

/** Resolve native config layers without a model request or configuration writes.
    The bridge returns only shell policy and never republishes CLI diagnostics. */
export async function readCodexShellPolicy(binary: string, cwd: string, env: NodeJS.ProcessEnv, args: readonly string[] = [], options: { ignoreUserConfig?: boolean } = {}): Promise<unknown> {
  // `exec --ignore-user-config` omits the account's config.toml. A metadata
  // probe needs no auth, so an empty home gives its config reader that view.
  const metadataHome = options.ignoreUserConfig ? fs.mkdtempSync(path.join(os.tmpdir(), "codex-policy-home-")) : null;
  const probeEnv = metadataHome ? { ...env, CODEX_HOME: metadataHome } : env;
  try {
    if (testReader) return await testReader(binary, cwd, probeEnv, args);
    const result = await new Promise<string | null>((resolve) => {
      execFile(process.execPath, ["--eval", CODEX_POLICY_BRIDGE, binary, ...args], {
        cwd, env: probeEnv, encoding: "utf8", timeout: 12_000, maxBuffer: 2 * 1024 * 1024,
      }, (error, stdout) => resolve(error ? null : stdout));
    });
    if (result !== null) {
      try {
        const policy: unknown = JSON.parse(result);
        if (policy && typeof policy === "object" && !Array.isArray(policy)) return policy;
      } catch { /* sanitized refusal below */ }
    }
    throw new Error("Codex shell policy could not be read safely");
  } finally {
    if (metadataHome) fs.rmSync(metadataHome, { recursive: true, force: true });
  }
}

// Keep the bridge bundled with this release, including packaged MCP callers.
const CODEX_POLICY_BRIDGE = String.raw`
import { spawn } from "node:child_process";

// Metadata only: no thread, account, model or turn requests are issued.
const child = spawn(process.argv[1], [...process.argv.slice(2), "app-server"], {
  stdio: ["pipe", "pipe", "ignore"], detached: true,
});
const ownedPid = child.pid;
let closed = false;
let failed = false;
let buffer = "";
const pending = new Map();
let nextId = 0;
const failure = () => new Error("Codex shell policy could not be read safely");
const rejectPending = () => { failed = true; for (const { reject } of pending.values()) reject(failure()); };
child.on("error", rejectPending);
child.on("close", () => {
  closed = true;
  rejectPending();
});
child.stdin.on("error", rejectPending);
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  if (buffer.length > 2 * 1024 * 1024) {
    rejectPending();
    return;
  }
  for (;;) {
    const end = buffer.indexOf("\n");
    if (end < 0) break;
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    try {
      const response = JSON.parse(line);
      const request = pending.get(response.id);
      if (!request) continue;
      pending.delete(response.id);
      if (response.error) request.reject(failure());
      else request.resolve(response.result);
    } catch { rejectPending(); }
  }
});
function request(method, params) {
  return new Promise((resolve, reject) => {
    if (failed || closed) { reject(failure()); return; }
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
function signalOwned(signal) {
  if (!closed && ownedPid > 0) { try { process.kill(-ownedPid, signal); } catch {} }
}
process.on("SIGTERM", () => { signalOwned("SIGTERM"); signalOwned("SIGKILL"); process.exit(1); });
const timeout = setTimeout(() => {
  rejectPending();
}, 8_000);
try {
  await request("initialize", { clientInfo: { name: "delegatus", version: "1" }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  const result = await request("config/read", { cwd: process.cwd(), includeLayers: false });
  if (!result?.config || typeof result.config !== "object") throw failure();
  const policy = result.config.shell_environment_policy ?? {};
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw failure();
  process.stdout.write(JSON.stringify(policy));
} catch { process.exitCode = 1; }
finally {
  clearTimeout(timeout);
  child.stdin.end();
  signalOwned("SIGTERM");
  if (!closed) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { signalOwned("SIGKILL"); resolve(); }, 1_000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }
}
`;
