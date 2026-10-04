import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { viewerControlOrigin, viewerControlToken } from "@/lib/mcp/controlEndpoint";

export function memoryHookOutput(block: string, _engine: string) {
  return block ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: block } } : {};
}

/** Self-contained because engines run on the host, outside the Viewer image. */
async function runHook(endpoint: string, token: string | null, queue: string | null) {
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
export function memoryHookSource(endpoint: string, token: string | null = null, queue: string | null = null) { return `(${runHook.toString()})(${JSON.stringify(endpoint)}, ${JSON.stringify(token)}, ${JSON.stringify(queue)}).catch(() => {}).finally(() => { process.exitCode = 0; });\n`; }
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

export function installMemoryHook(home: string, env: NodeJS.ProcessEnv = process.env, queue: string | null = null) {
  if (!env.LLV_SPAWN_CAPABILITY) return null;
  const endpoint = env.LLV_VIEWER_PORT ? `http://127.0.0.1:${Number(env.LLV_VIEWER_PORT)}` : viewerControlOrigin(env);
  const suffix = crypto.createHash("sha256").update(endpoint + (queue ?? "")).digest("hex").slice(0, 12);
  const file = path.join(home, ".llv", "hooks", `shared-memory-${suffix}.mjs`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const source = memoryHookSource(endpoint, viewerControlToken(env, endpoint), queue);
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== source) {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, source, { mode: 0o600 }); fs.renameSync(temporary, file);
  }
  return { type: "command", command: `bun ${quote(file)} 2>/dev/null || true`, timeout: 2, additionalContextLimit: 40000 };
}

/** Preserve native hooks. Trust is granted later only to this exact handler. */
export function installCodexMemoryHook(home: string, env: NodeJS.ProcessEnv) {
  const hook = installMemoryHook(home, env);
  if (!hook) return null;
  const file = path.join(home, "hooks.json");
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const hooks = config.hooks ??= {};
  const groups = hooks.UserPromptSubmit ?? [];
  if (!Array.isArray(groups)) return null;
  if (!groups.some(g => g.hooks?.some((h: { command?: string }) => h.command === hook.command))) {
    hooks.UserPromptSubmit = [...groups, { hooks: [hook] }];
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(config), { mode: 0o600 }); fs.renameSync(temporary, file);
  }
  return hook;
}

/** Metadata-only setup for the native terminal, before it reads hook trust. */
async function trustTerminalHook(binary: string, home: string, cwd: string, command: string) {
  const child = process.getBuiltinModule("child_process").spawn(binary, ["app-server"], {
    cwd, env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "ignore"],
  });
  const pending = new Map(); let nextId = 0, buffer = "";
  const fail = () => { for (const p of pending.values()) p.reject(Error("optional hook setup unavailable")); pending.clear(); };
  child.on("error", fail); child.on("close", fail); child.stdin.on("error", fail);
  child.stdout.on("data", chunk => {
    buffer += String(chunk);
    if (buffer.length > 256000) { fail(); return; }
    for (;;) {
      const end = buffer.indexOf("\n"); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const response = JSON.parse(line), p = pending.get(response.id);
        if (!p) continue;
        pending.delete(response.id);
        if (response.error) p.reject(Error("optional hook setup refused")); else p.resolve(response.result);
      } catch { fail(); }
    }
  });
  const rpc = (method: string, params: object) => new Promise<unknown>((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  const timer = setTimeout(() => { fail(); child.kill("SIGKILL"); }, 500);
  try {
    await rpc("initialize", { clientInfo: { name: "delegatus", version: "1" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const listed = await rpc("hooks/list", { cwds: [cwd] }) as { data: Array<{ hooks: Array<{ key: string; command?: string; currentHash: string }> }> };
    for (const hook of listed.data.flatMap(d => d.hooks)) {
      if (hook.command !== command || !/^sha256:[a-f0-9]{64}$/i.test(hook.currentHash)) continue;
      await rpc("config/value/write", { keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`, value: hook.currentHash, mergeStrategy: "replace" });
    }
  } catch { /* setup cannot block the terminal */ }
  finally { clearTimeout(timer); child.stdin.end(); child.kill("SIGKILL"); }
}

export function codexTerminalMemorySetup(home: string, cwd: string, binary: string, env: NodeJS.ProcessEnv) {
  const hook = installCodexMemoryHook(home, env);
  if (!hook) return "";
  const suffix = crypto.createHash("sha256").update(JSON.stringify([binary, cwd, hook.command])).digest("hex").slice(0, 12);
  const file = path.join(home, ".llv", "hooks", `shared-memory-trust-${suffix}.mjs`);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `(${trustTerminalHook.toString()})(${JSON.stringify(binary)}, ${JSON.stringify(home)}, ${JSON.stringify(cwd)}, ${JSON.stringify(hook.command)}).catch(() => {}).finally(() => { process.exitCode = 0; });\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return `bun ${quote(file)} 2>/dev/null || true;`;
}
