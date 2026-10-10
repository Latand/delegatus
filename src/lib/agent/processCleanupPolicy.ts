import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROCESS_CLEANUP_HOOK_PREFIX = "LLV_MANAGED_PROCESS_CLEANUP_DENY=1 ";
export const PROCESS_CLEANUP_DENY_MESSAGE = "PID-only process cleanup: stop only processes you started, using the PID recorded at start. Never stop by name, pattern or port. Bind probe servers to port 0 and read back their assigned port.";

/** Recognizes common process cleanup commands at the hook boundary.
 * Kept self-contained so the installed hook needs no repository or packages. */
export function forbiddenProcessCleanup(command: string): boolean {
  type Word = { value: string; substituted: boolean };
  const words: Word[] = [];
  let word = "", started = false, substituted = false, quote = "", pipelineLookup = false;
  const basename = (value: string) => value.split("/").pop() ?? value;
  const flush = () => {
    if (started) words.push({ value: word, substituted });
    word = ""; started = false; substituted = false;
  };
  const inspect = (input: Word[]): boolean => {
    const args = [...input];
    while (args.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0].value)
      || ["!", "if", "then", "else", "do"].includes(args[0].value))) args.shift();
    const executable = basename(args.shift()?.value ?? "");
    if (["pkill", "killall"].includes(executable)) return true;
    if (executable === "fuser") return args.some(({ value }) => value === "--kill" || /^-[^-]*k/.test(value));
    if (["lsof", "pgrep"].includes(executable)) pipelineLookup = true;
    if (executable === "kill") return pipelineLookup || args.some((arg) => arg.substituted);
    if (["sh", "bash", "zsh", "dash", "ksh"].includes(executable)) {
      const index = args.findIndex(({ value }) => /^-[^-]*c/.test(value));
      return index >= 0 && forbiddenProcessCleanup(args[index + 1]?.value ?? "");
    }
    if (["command", "builtin", "exec", "nohup", "sudo", "pkexec", "env", "rtk", "xargs", "timeout"].includes(executable)) {
      if (executable === "command" && args.some(arg => ["-v", "-V"].includes(arg.value))) return false;
      if (executable === "rtk" && args[0]?.value === "proxy") args.shift();
      const valueOptions: Record<string, string[]> = {
        sudo: ["-u", "-g", "-h", "-p", "-C", "--user", "--group"],
        env: ["-u", "-C", "--unset", "--chdir"],
        exec: ["-a"], xargs: ["-n", "-P", "-I", "-s"],
        timeout: ["--signal", "--kill-after", "-s", "-k"],
      };
      while (args[0]?.value.startsWith("-")) {
        const flag = args.shift()!.value;
        if (valueOptions[executable]?.includes(flag)) args.shift();
        if (flag === "--") break;
      }
      if (executable === "timeout") args.shift();
      return inspect(args);
    }
    return false;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "\\" && quote !== "'") { word += command[++i] ?? ""; started = true; continue; }
    if (char === quote) { quote = ""; continue; }
    if (!quote && (char === "'" || char === '"')) { quote = char; started = true; continue; }
    if (quote !== "'" && (char === "`" || (char === "$" && command[i + 1] === "("))) {
      const backtick = char === "`";
      const start = i + (backtick ? 1 : 2);
      let depth = 1, end = start, innerQuote = "";
      for (; end < command.length; end++) {
        const current = command[end];
        if (current === "\\") { end++; continue; }
        if (backtick) { if (current === "`") break; continue; }
        if (current === innerQuote) { innerQuote = ""; continue; }
        if (!innerQuote && (current === "'" || current === '"')) { innerQuote = current; continue; }
        if (!innerQuote && current === "(") depth++;
        if (!innerQuote && current === ")" && --depth === 0) break;
      }
      if (forbiddenProcessCleanup(command.slice(start, end))) return true;
      word += command.slice(i, end + 1); started = true; substituted = true; i = end;
      continue;
    }
    if (!quote && char === "#" && !started) {
      while (i < command.length && command[i] !== "\n") i++;
    }
    if (!quote && /[;|&\n(){}]/.test(command[i] ?? "")) {
      flush();
      if (inspect(words.splice(0))) return true;
      if (command[i] !== "|" || command[i + 1] === "|" || command[i - 1] === "|") pipelineLookup = false;
    } else if (!quote && /\s/.test(command[i] ?? "")) flush();
    else { word += command[i] ?? ""; started = true; }
  }
  flush();
  return inspect(words);
}

export function installProcessCleanupHook(home: string): string {
  const file = path.join(home, ".llv", "hooks", "deny-process-cleanup.mjs");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const script = `const forbidden = ${forbiddenProcessCleanup.toString()};
const message = ${JSON.stringify(PROCESS_CLEANUP_DENY_MESSAGE)};
try {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw).tool_input;
  const command = input?.cmd ?? input?.command;
  const text = Array.isArray(command) ? command.map(value => "'" + String(value).replaceAll("'", "'\\\\''") + "'").join(" ") : command;
  if (typeof text !== "string" || forbidden(text)) { console.error(message); process.exitCode = 2; }
} catch { console.error(message); process.exitCode = 2; }
`;
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, script, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return `${PROCESS_CLEANUP_HOOK_PREFIX}bun '${file.replaceAll("'", "'\\''")}'`;
}

/** Session flags carry both the declaration and its trust; account config and
 * hooks.json are untouched. Hash/key format follows Codex's hook discovery in
 * rust-v0.154.0 and rust-v0.159.0 and is exercised with the native interpreter. */
export function codexProcessCleanupConfig(home: string = path.join(os.homedir(), ".codex")) {
  const command = installProcessCleanupHook(home);
  const handler = { async: false, command, timeout: 10, type: "command" };
  const group = { hooks: [handler], matcher: "Bash|shell|shell_command|exec_command" };
  const hash = "sha256:" + crypto.createHash("sha256").update(JSON.stringify({ event_name: "pre_tool_use", ...group })).digest("hex");
  const key = "/<session-flags>/config.toml:pre_tool_use:0:0";
  return { features: { hooks: true, codex_hooks: true }, hooks: {
    PreToolUse: [{ matcher: group.matcher, hooks: [{ type: "command", command, timeout: 10 }] }],
    state: { [key]: { enabled: true, trusted_hash: hash } },
  } };
}

export function codexProcessCleanupArgs(home: string = path.join(os.homedir(), ".codex")): string[] {
  const config = codexProcessCleanupConfig(home);
  // TOML inline tables omit nulls; discovery restores those optional fields.
  const group = config.hooks.PreToolUse[0];
  const command = group.hooks[0].command;
  return ["-c", "features.hooks=true", "-c", "features.codex_hooks=true", "-c", `hooks.PreToolUse=[{matcher=${JSON.stringify(group.matcher)},hooks=[{type="command",command=${JSON.stringify(command)},timeout=10}]}]`,
    "-c", `hooks.state={${Object.entries(config.hooks.state).map(([key, state]) => `${JSON.stringify(key)}={enabled=true,trusted_hash=${JSON.stringify(state.trusted_hash)}}`).join(",")}}`];
}
