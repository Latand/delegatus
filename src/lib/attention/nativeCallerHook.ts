import fs from "node:fs";
import path from "node:path";
import { procBackend } from "@/lib/proc";
import { argvEngine, isHelperArgv } from "@/lib/scanner/process";
import { processAncestry } from "./callerAuthority";
import { recordNativeHook } from "./nativeCallProof";

/** Claude supplies hook session identity independently of its asynchronous PID
 * record. The kernel supplies its parent; stdin cannot choose a PID or start token. */
export async function runNativeCallerHook(): Promise<void> {
  const owner = process.ppid;
  const ownerStart = procBackend.processIdentity(owner);
  const claude = processAncestry(process.pid, candidate => procBackend.readPpid(candidate)).slice(1)
    .find(candidate => argvEngine(procBackend.readArgv(candidate)) === "claude" && !isHelperArgv(procBackend.readArgv(candidate)));
  const claudeStart = claude ? procBackend.processIdentity(claude) : null;
  const owned = () => procBackend.readPpid(process.pid) === owner && ownerStart !== null && procBackend.processIdentity(owner) === ownerStart
    && (!claude || (claudeStart !== null && procBackend.processIdentity(claude) === claudeStart && !procBackend.processExited(claude)));
  const monitor = setInterval(() => { if (!owned()) process.exit(1); }, 100);
  try { await handleNativeCallerHook(owned); }
  finally { clearInterval(monitor); }
}
async function handleNativeCallerHook(owned: () => boolean): Promise<void> {
  // Managed callers retain their launch credential and need no native proof.
  if (process.env.LLV_SPAWN_CAPABILITY !== undefined) return;
  if (procBackend.name !== "linux") throw new Error("native caller hooks are verified only on Linux");
  const pid = processAncestry(process.pid, candidate => procBackend.readPpid(candidate)).slice(1)
    .find(candidate => argvEngine(procBackend.readArgv(candidate)) === "claude" && !isHelperArgv(procBackend.readArgv(candidate)));
  if (!pid) throw new Error("native caller hook needs its Claude parent");
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) { bytes += Buffer.byteLength(chunk); if (bytes > 4 * 1024 * 1024) throw new Error("native caller hook input exceeds 4 MiB"); chunks.push(Buffer.from(chunk)); }
  if (!owned()) throw new Error("native hook owner ended");
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  const event = input.hook_event_name;
  if (!["SessionStart", "SessionEnd", "PreToolUse"].includes(String(event)) || typeof input.session_id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.session_id) || typeof input.transcript_path !== "string") throw new Error("invalid native caller hook event");
  const home = procBackend.readEnvVar(pid, "CLAUDE_CONFIG_DIR") || path.join(procBackend.readEnvVar(pid, "HOME") ?? "", ".claude");
  const root = fs.realpathSync(path.join(home, "projects"));
  const transcript = path.join(fs.realpathSync(path.dirname(input.transcript_path)), path.basename(input.transcript_path));
  const relative = path.relative(root, transcript);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`) || path.basename(transcript) !== `${input.session_id}.jsonl`) throw new Error("native hook transcript is outside its account");
  if (event !== "PreToolUse") { recordNativeHook(pid, input.session_id, transcript, event as "SessionStart" | "SessionEnd"); return; }
  if (typeof input.tool_name !== "string" || !/^mcp__viewer__[a-z_]+$/.test(input.tool_name) || !input.tool_input || typeof input.tool_input !== "object" || Array.isArray(input.tool_input)) throw new Error("invalid native MCP hook input");
  const args = input.tool_input as Record<string, unknown>;
  const { token } = recordNativeHook(pid, input.session_id, transcript, "PreToolUse", input.tool_name.slice("mcp__viewer__".length), args);
  if (!owned()) throw new Error("native hook owner ended");
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...args, nativeCallerProof: token } } }) + "\n");
}
