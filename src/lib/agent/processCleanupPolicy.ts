import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROCESS_CLEANUP_HOOK_PREFIX = "LLV_MANAGED_PROCESS_CLEANUP_DENY=1 ";
export const PROCESS_CLEANUP_DENY_MESSAGE = "PID-only process cleanup: stop only processes you started, using the PID recorded at start. Never stop by name, pattern or port. Bind probe servers to port 0 and read back their assigned port.";

/** Recognizes common process cleanup commands at the hook boundary.
 * Kept self-contained so the installed hook needs no repository or packages. */
export function forbiddenProcessCleanup(command: string, expansionsOnly = false, stdinLookup = false): boolean {
  type Word = { value: string; substituted: boolean; redirected: boolean };
  const words: Word[] = [];
  const groupLookups: boolean[] = [];
  const heredocs: { delimiter: string; literal: boolean; stripTabs: boolean; executable: boolean }[] = [];
  const pipelineBodies: string[] = [];
  let pipelineContinuation = false, pipelineHeredocStart = 0;
  let word = "", started = false, substituted = false, quote = "", pipelineLookup = false;
  let redirected = false, quotedWord = false, inArray = false;
  const lookupInput = () => stdinLookup || pipelineLookup || groupLookups.some(Boolean);
  const basename = (value: string) => value.split("/").pop() ?? value;
  const flush = () => {
    if (started) {
      if (!inArray) words.push({ value: word, substituted, redirected });
      redirected = false;
    }
    word = ""; started = false; substituted = false; quotedWord = false;
  };
  const inspect = (input: Word[]): boolean => {
    if (expansionsOnly) return false;
    const args = input.filter(arg => !arg.redirected);
    while (args.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0].value)
      || ["!", "if", "then", "else", "do"].includes(args[0].value))) args.shift();
    const executable = basename(args.shift()?.value ?? "");
    if (["pkill", "killall"].includes(executable)) return true;
    if (executable === "fuser") return args.some(({ value }) => value === "--kill" || /^-[^-]*k/.test(value));
    if (["lsof", "pgrep"].includes(executable)) pipelineLookup = true;
    if (executable === "kill") return lookupInput() || args.some((arg) => arg.substituted);
    if (["sh", "bash", "zsh", "dash", "ksh"].includes(executable)) {
      const index = args.findIndex(({ value }) => /^-[^-]*c/.test(value));
      // A shell reading stdin executes even a quoted heredoc, including one
      // supplied by an earlier command in the same pipeline.
      let readsStdin = true;
      for (let index = 0; index < args.length; index++) {
        const value = args[index].value;
        if (/^-[^-]*s/.test(value)) break;
        if (["-o", "+o", "-O", "+O", "--rcfile", "--init-file"].includes(value)) { index++; continue; }
        if (value !== "-" && /^[+-]/.test(value)) continue;
        readsStdin = value === "-";
        break;
      }
      if (index < 0 && readsStdin) {
        if (pipelineBodies.some(body => forbiddenProcessCleanup(body))) return true;
        for (const document of heredocs.slice(pipelineHeredocStart)) document.executable = true;
      }
      return index >= 0 && forbiddenProcessCleanup(args[index + 1]?.value ?? "", false, lookupInput());
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
    // Shell line continuations contribute no character or word boundary.
    if (char === "\\" && quote !== "'" && command[i + 1] === "\n") { i++; continue; }
    if (char === "\\" && quote !== "'") { word += command[++i] ?? ""; started = true; quotedWord = true; continue; }
    if (char === quote) { quote = ""; continue; }
    if (!expansionsOnly && !quote && (char === "'" || char === '"')) { quote = char; started = true; quotedWord = true; continue; }
    if (!expansionsOnly && !quote && !inArray && char === "{" && !started) {
      const descriptor = command.slice(i).match(/^\{[A-Za-z_][A-Za-z0-9_]*\}(?=[<>])/);
      if (descriptor) { i += descriptor[0].length - 1; continue; }
    }
    if (!expansionsOnly && !quote && !inArray && (char === "<" || char === ">" || (char === "&" && command[i + 1] === ">")) && command[i + 1] !== "(") {
      // A contiguous, unquoted descriptor belongs to the redirect, not argv.
      // Its operand still passes through expansion scanning below.
      if (started && !quotedWord && /^\d+$/.test(word)) { word = ""; started = false; }
      flush();
      if (!(char === "<" && command[i + 1] === "<" && command[i + 2] !== "<" && command[i - 1] !== "<")) {
        if (char === "&") i++;
        if (command[i + 1] === command[i]) { i++; if (command[i + 1] === "<") i++; }
        else if (command[i + 1] === "&" || command[i + 1] === "|" || (char === "<" && command[i + 1] === ">")) i++;
        redirected = true;
        continue;
      }
    }
    if (!expansionsOnly && !quote && char === "<" && command[i + 1] === "<" && command[i + 2] !== "<" && command[i - 1] !== "<") {
      flush();
      let end = i + 2, delimiter = "", delimiterQuote = "", literal = false;
      const stripTabs = command[end] === "-";
      if (stripTabs) end++;
      while (/[ \t]/.test(command[end] ?? "")) end++;
      for (; end < command.length; end++) {
        const current = command[end];
        if (!delimiterQuote && /[\s;|&<>()>]/.test(current)) break;
        if (current === "\\" && delimiterQuote !== "'") {
          if (command[end + 1] === "\n") { end++; continue; }
          literal = true;
          if (delimiterQuote === '"' && !/[$`"\\]/.test(command[end + 1] ?? "")) delimiter += current;
          else delimiter += command[++end] ?? "";
          continue;
        }
        if (current === delimiterQuote) { delimiterQuote = ""; continue; }
        if (!delimiterQuote && (current === "'" || current === '"')) { delimiterQuote = current; literal = true; continue; }
        delimiter += current;
      }
      heredocs.push({ delimiter, literal, stripTabs, executable: false });
      i = end - 1;
      continue;
    }
    const processSubstitution = !expansionsOnly && !quote && (char === "<" || char === ">") && command[i + 1] === "(";
    if (quote !== "'" && (char === "`" || (char === "$" && command[i + 1] === "(") || processSubstitution)) {
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
      // Arithmetic names are data; nested substitutions still execute.
      const arithmetic = char === "$" && command[i + 2] === "(";
      if (forbiddenProcessCleanup(command.slice(start, end), arithmetic, lookupInput())) return true;
      word += command.slice(i, end + 1); started = true; substituted = true; i = end;
      continue;
    }
    if (!expansionsOnly && !quote && !inArray && char === "(" && started && /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]+\])?\+?=$/.test(word)) {
      flush(); inArray = true;
      continue;
    }
    if (!expansionsOnly && !quote && char === "#" && !started) {
      while (i < command.length && command[i] !== "\n") i++;
    }
    if (inArray) {
      // Array elements are data; substitutions were inspected above.
      if (!quote && command[i] === ")") { flush(); inArray = false; }
      else if (!quote && /\s/.test(command[i] ?? "")) flush();
      else { word += command[i] ?? ""; started = true; }
      continue;
    }
    if (!quote && /[;|&\n(){}]/.test(command[i] ?? "")) {
      flush();
      const hadWords = words.length > 0;
      if (inspect(words.splice(0))) return true;
      if (command[i] === "(" || command[i] === "{") {
        groupLookups.push(lookupInput());
        pipelineContinuation = false;
      } else if (command[i] === ")" || command[i] === "}") {
        pipelineLookup = (groupLookups.pop() ?? false) || pipelineLookup;
        pipelineContinuation = false;
      } else if (command[i] === "|" && command[i + 1] !== "|" && command[i - 1] !== "|") pipelineContinuation = true;
      else if (!(command[i] === "\n" && !hadWords && pipelineContinuation)) {
        pipelineLookup = false; pipelineContinuation = false; pipelineHeredocStart = heredocs.length;
        pipelineBodies.length = 0;
      }
      if (command[i] === "\n" && heredocs.length) {
        // Bodies begin after the complete command line, in declaration order.
        // Quotes in an unquoted body are data; only its expansions run here.
        let offset = i + 1;
        for (const document of heredocs.splice(0)) {
          let body = "";
          while (offset < command.length) {
            let line = "", continued: boolean;
            do {
              const newline = command.indexOf("\n", offset);
              const end = newline < 0 ? command.length : newline;
              const physical = command.slice(offset, end);
              offset = newline < 0 ? end : end + 1;
              continued = !document.literal && newline >= 0 && (physical.match(/\\+$/)?.[0].length ?? 0) % 2 === 1;
              line += continued ? physical.slice(0, -1) : physical;
            } while (continued && offset < command.length);
            if (document.stripTabs) line = line.replace(/^\t+/, "");
            if (line === document.delimiter) break;
            body += line + "\n";
          }
          if ((!document.literal && forbiddenProcessCleanup(body, true))
            || (document.executable && forbiddenProcessCleanup(body))) return true;
          if (pipelineContinuation) pipelineBodies.push(body);
        }
        i = offset - 1;
        pipelineHeredocStart = 0;
      }
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
