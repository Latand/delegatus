import { execFile } from "node:child_process";
import { systemBootEpoch, type ProcessIdentity } from "@/lib/processIdentity";

/** Unit names are unique per launch. Legacy rows with no boot proof remain unkillable. */
export interface AgentScopeIdentity { unit: string; bootEpoch: string | null }

export function normalizeAgentScope(value: unknown): AgentScopeIdentity | null {
  if (!value || typeof value !== "object") return null;
  const scope = value as AgentScopeIdentity;
  return typeof scope.unit === "string" && /^delegatus-agent-[\w.-]+\.scope$/.test(scope.unit)
    && (scope.bootEpoch === null || (typeof scope.bootEpoch === "string" && scope.bootEpoch.length > 0))
    ? { unit: scope.unit, bootEpoch: scope.bootEpoch } : null;
}

type ScopeRecord = { scope?: AgentScopeIdentity; memory?: { unit: string | null }; process?: ProcessIdentity | null; exitProcess?: ProcessIdentity };

/** Read older memory-backed rows as well as CPU-only scopes. */
export function recordedAgentScope(host: ScopeRecord | null | undefined): AgentScopeIdentity | null {
  if (!host) return null;
  if (host.scope) {
    const scope = normalizeAgentScope(host.scope);
    if (!scope) throw new Error("recorded agent scope identity is malformed");
    return scope;
  }
  if (!host.memory?.unit) return null;
  const scope = normalizeAgentScope({ unit: host.memory.unit, bootEpoch: host.process?.bootEpoch ?? host.exitProcess?.bootEpoch ?? null });
  if (!scope) throw new Error("recorded agent scope boot identity is unavailable");
  return scope;
}

/** A terminal row can retain the native exit identity after dropping its live PID. */
export function recordedScopeProcess(host: ScopeRecord | null | undefined): ProcessIdentity | null {
  return host?.process ?? (recordedAgentScope(host) ? host?.exitProcess ?? null : null);
}

export function sameAgentScope(left: AgentScopeIdentity | null, right: AgentScopeIdentity | null): boolean {
  return left?.unit === right?.unit && left?.bootEpoch === right?.bootEpoch;
}

/** A PID namespace change alone proves nothing about a unit in the user
 * manager. A different kernel boot ID proves the old transient scope is gone. */
export function differentKernelBoot(recorded: string, current: string | null): boolean {
  const linux = /^linux:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}):pidns:pid:\[\d+\]$/;
  const priorId = linux.exec(recorded)?.[1];
  const currentId = current ? linux.exec(current)?.[1] : null;
  return !!priorId && !!currentId && priorId !== currentId;
}

export function agentScopeCommand(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile("systemctl", ["--user", ...args],
    { encoding: "utf8", timeout: 2_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      // `show` exits nonzero for a collected transient unit, but still names its state.
      if (error && !(args[0] === "show" && stdout.trim() === "not-found")) reject(new Error("agent scope control is unavailable"));
      else resolve(stdout.trim());
    }));
}

/** Stop the exact recorded cgroup, including detached children, then prove collection. */
export async function stopAgentScope(scope: AgentScopeIdentity, options: {
  authorize(): void;
  authorizeAsync?(): Promise<void>;
  command?: (args: string[]) => Promise<string>;
  bootEpoch?: () => string | null;
  deadlineMs?: number;
}): Promise<void> {
  if (!normalizeAgentScope(scope) || !scope.bootEpoch) {
    throw new Error("agent scope boot identity changed");
  }
  const currentBoot = (options.bootEpoch ?? systemBootEpoch)();
  if (currentBoot !== scope.bootEpoch && !differentKernelBoot(scope.bootEpoch, currentBoot)) {
    throw new Error("agent scope boot identity changed");
  }
  const command = options.command ?? agentScopeCommand;
  const deadline = Date.now() + (options.deadlineMs ?? 5_000);
  const bounded = async <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("agent scope termination deadline exceeded")), Math.max(0, deadline - Date.now()));
      })]);
    } finally { clearTimeout(timer); }
  };
  if (currentBoot !== scope.bootEpoch) {
    // Retire only the recorded custody; a current unit reusing its name is
    // unrelated and must receive no command, including a state query.
    await bounded(Promise.resolve(options.authorizeAsync?.()));
    options.authorize();
    return;
  }
  const authorized = async (args: string[]) => {
    await bounded(Promise.resolve(options.authorizeAsync?.()));
    options.authorize();
    if (Date.now() >= deadline) throw new Error("agent scope termination deadline exceeded");
    const result = await bounded(command(args));
    await bounded(Promise.resolve(options.authorizeAsync?.()));
    options.authorize();
    return result;
  };
  const state = () => authorized(["show", "--value", "-p", "LoadState", scope.unit]);
  if (await state() === "not-found") return;
  // Kill all members even when the root exited or its descendants called setsid.
  try { await authorized(["kill", "--kill-who=all", "--signal=SIGKILL", scope.unit]); }
  catch (error) { if (await state() === "not-found") return; throw error; }
  try { await authorized(["stop", "--no-block", scope.unit]); }
  catch (error) { if (await state() === "not-found") return; throw error; }
  while (Date.now() < deadline) {
    if (await state() === "not-found") return;
    await new Promise<void>(resolve => setTimeout(resolve, 25));
    options.authorize();
  }
  throw new Error("agent scope survived termination");
}
