import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { viewerControlOrigin, viewerControlToken, viewerControlCredentialFiles, type ViewerCredentialFile } from "@/lib/mcp/controlEndpoint";
import { viewerMcpStateContext } from "../../../bin/mcp-state-paths.mjs";
import { assertStateStartupMutation } from "@/lib/stateOwnership";

export function memoryHookOutput(block: string, _engine: string) {
  return block ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: block } } : {};
}

/** Self-contained because engines run on the host, outside the Viewer image. */
async function runHook(endpoint: string, credentials: readonly ViewerCredentialFile[], queue: string | null) {
  const deadline = performance.now() + 1500;
  const expires = Date.now() + 1500;
  const hookId = process.getBuiltinModule("crypto").randomUUID();
  const abort = new AbortController();
  const timer = setTimeout(() => { abort.abort(); process.exit(0); }, 1500);
  try {
    let raw = "";
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 128000 || performance.now() >= deadline) return;
    }
    if (performance.now() >= deadline) return;
    const input = JSON.parse(raw);
    if (input.hook_event_name !== "UserPromptSubmit" || typeof input.prompt !== "string") return;
    if (queue) {
      // This function is serialized after Next compilation; builtin access
      // must remain self-contained without a bundler module loader.
      const fs = process.getBuiltinModule("fs");
      const crypto = process.getBuiltinModule("crypto");
      const entries = fs.readFileSync(queue, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const consumed = new Set(fs.existsSync(queue + ".consumed") ? fs.readFileSync(queue + ".consumed", "utf8").trim().split("\n") : []);
      const entry = entries.find(e => !consumed.has(e.id));
      if (!entry) return;
      fs.appendFileSync(queue + ".consumed", entry.id + "\n", { mode: 0o600 });
      if (entry.digest !== crypto.createHash("sha256").update(input.prompt).digest("hex")) return;
      input.delegatus_delivery_id = entry.id;
    }
    const capability = process.env.LLV_SPAWN_CAPABILITY;
    if (!capability || performance.now() >= deadline) return;
    // Credentials are read for this invocation, never serialized into the hook.
    let token: string | undefined;
    for (const credential of credentials) {
      if (token) break;
      try {
        const raw = process.getBuiltinModule("fs").readFileSync(credential.path, "utf8");
        const value = credential.format === "compose" ? JSON.parse(raw)?.services?.viewer?.environment?.LLV_TOKEN : raw;
        const normalized = typeof value === "string" ? value.trim() : "";
        if (normalized && !/[^\x20-\x7e]/.test(normalized)) token = normalized;
      } catch { /* An installation without a key sends no bearer. */ }
    }
    if (performance.now() >= deadline) return;
    const headers = { "Content-Type": "application/json", "x-llv-spawn-capability": capability,
      "x-llv-memory-deadline": String(expires), "x-llv-memory-hook": hookId, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const response = await fetch(endpoint + "/api/memory/inject", { method: "POST", signal: abort.signal, headers, body: JSON.stringify(input) });
    if (!response.ok || performance.now() >= deadline) return;
    const body = await response.json();
    if (typeof body.block === "string" && body.block && body.block.length <= 10000) {
      const output = JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: body.block } });
      if (performance.now() >= deadline) return;
      const emittedAt = Date.now();
      await new Promise<void>((resolve, reject) => process.stdout.write(output, error => error ? reject(error) : resolve()));
      // Successful output is a delivery fact. Send its evidence independently
      // of selection cancellation; the original process deadline still holds.
      await fetch(endpoint + "/api/memory/inject", { method: "POST", signal: AbortSignal.timeout(1000), headers,
        body: JSON.stringify({ delegatus_confirm: true, delegatus_emitted_at: emittedAt }) });
    }
  } catch { /* fail open, with no prompt or credential in diagnostics */ }
  finally { clearTimeout(timer); abort.abort(); }
}
export function memoryHookSource(endpoint: string, credentials: readonly ViewerCredentialFile[] | null = null, queue: string | null = null) { return `(${runHook.toString()})(${JSON.stringify(endpoint)}, ${JSON.stringify(credentials ?? [])}, ${JSON.stringify(queue)}).catch(() => {}).finally(() => { process.exitCode = 0; });\n`; }
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

export function installMemoryHook(home: string, env: NodeJS.ProcessEnv = process.env, queue: string | null = null, prefix = "shared-memory") {
  if (!env.LLV_SPAWN_CAPABILITY) return null;
  const endpoint = env.LLV_VIEWER_PORT ? `http://127.0.0.1:${Number(env.LLV_VIEWER_PORT)}` : viewerControlOrigin(env);
  const suffix = crypto.createHash("sha256").update(endpoint + (queue ?? "")).digest("hex").slice(0, 12);
  const file = path.join(home, ".llv", "hooks", `${prefix}-${suffix}.mjs`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const credentials = viewerControlCredentialFiles(env, endpoint);
  // An environment-only install has no existing credential file for the host
  // to read after the agent environment is scrubbed. Keep that credential in
  // protected Delegatus state, subject to the control client's origin policy.
  const explicit = env.LLV_VIEWER_CONTROL_TOKEN || env.LLV_TOKEN ? viewerControlToken(env, endpoint) : null;
  if (explicit) {
    const state = viewerMcpStateContext(env, path.join(os.homedir(), ".config")).stateDirectory;
    assertStateStartupMutation(state, "memory hook credential", env);
    const directory = path.join(state, "memory-hook-credentials");
    const inside = (root: string, target: string) => {
      const relative = path.relative(root, target);
      return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
    };
    const refusal = "memory hook credentials require Delegatus state outside the engine home";
    if (inside(path.resolve(home), path.resolve(directory))) throw new Error(refusal);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (inside(fs.realpathSync(home), fs.realpathSync(directory))) throw new Error(refusal);
    const file = path.join(directory, crypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 12));
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, explicit, { mode: 0o600 }); fs.renameSync(temporary, file); }
    finally { fs.rmSync(temporary, { force: true }); }
    credentials.unshift({ path: file, format: "text" });
  }
  const source = memoryHookSource(endpoint, credentials, queue);
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== source) {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, source, { mode: 0o600 }); fs.renameSync(temporary, file); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  return { type: "command", command: `bun ${quote(file)} 2>/dev/null || true`, timeout: 2, additionalContextLimit: 40000 };
}

/** Launch-scoped declaration; the account's native configuration is untouched. */
export function installCodexMemoryHook(home: string, env: NodeJS.ProcessEnv) {
  return installMemoryHook(home, env, null, "memory-launch");
}

/** Codex normalizes through TOML, whose map keys are sorted and omit nulls.
 * Verified against the installed 0.162.1 hooks/list before implementation. */
export function codexMemoryHookConfig(hook: NonNullable<ReturnType<typeof installCodexMemoryHook>>) {
  const handler = { additionalContextLimit: hook.additionalContextLimit, async: false, command: hook.command, timeout: hook.timeout, type: hook.type };
  const trusted_hash = "sha256:" + crypto.createHash("sha256").update(JSON.stringify({ event_name: "user_prompt_submit", hooks: [handler] })).digest("hex");
  return { UserPromptSubmit: [{ hooks: [hook] }], state: {
    "/<session-flags>/config.toml:user_prompt_submit:0:0": { enabled: true, trusted_hash },
  } };
}

/** A dotted state key contains dots itself; pass its entire inline table. */
export function codexMemoryHookArgs(hook: NonNullable<ReturnType<typeof installCodexMemoryHook>>, existingState: Record<string, { enabled: boolean; trusted_hash: string }> = {}): string[] {
  const config = codexMemoryHookConfig(hook);
  return ["-c", "features.hooks=true", "-c", "features.codex_hooks=true", "-c",
    `hooks.UserPromptSubmit=[{hooks=[{type="command",command=${JSON.stringify(hook.command)},timeout=2,additionalContextLimit=40000}]}]`,
    "-c", `hooks.state={${Object.entries({ ...existingState, ...config.state }).map(([key, state]) => `${JSON.stringify(key)}={enabled=${state.enabled},trusted_hash=${JSON.stringify(state.trusted_hash)}}`).join(",")}}`,
  ];
}
