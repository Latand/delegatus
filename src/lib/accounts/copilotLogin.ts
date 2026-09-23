import { spawn } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";

import { resolveCopilotBinary } from "@/lib/agent/cli";
import { signalDetachedProcessGroup } from "@/lib/processGroup";
import { copilotChildEnv } from "@/lib/runtime/copilotAcpHost";
import type { LoginOperationSummary, LoginPhase, LoginResult } from "./contracts";
import { copilotSignedInUser, listCopilotAccounts } from "./copilot";

export const COPILOT_LOGIN_TIMEOUT_MS = 15 * 60_000;
export const COPILOT_LOGIN_TERM_GRACE_MS = 2_000;
export const COPILOT_LOGIN_PHASES: ReadonlySet<LoginPhase> = new Set(["starting", "awaiting_browser", "awaiting_storage_choice", "verifying", "canceling"]);
const OUTPUT_LIMIT = 64 * 1024;
const ANSI = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/g;
/* C5-shaped fixture for Copilot CLI 1.0.87 device-code output:
   `To authenticate, visit https://github.com/login/device and enter code XXXX-XXXX`.
   A real second-account sign-in capture remains unverified. The code is always redacted
   in persisted state and is never written outside the live operation. */
const DEVICE_URL = /https:\/\/github\.com\/login\/device(?:\b|\/|\?[^\s]*)/i;
const USER_CODE = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/;
const PLAINTEXT_STORAGE_PROMPT = /system keychain unavailable\.\s*store token in plaintext config file\?\s*\(y\/n\)/i;

export interface CopilotLoginChild {
  pid?: number;
  stdin?: { write(data: string): boolean } | null;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export interface CopilotLoginPorts {
  spawn(command: string, args: string[], options: Parameters<typeof spawn>[2]): CopilotLoginChild;
  signalGroup(child: CopilotLoginChild, signal: NodeJS.Signals): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  setTimeout(callback: () => void, ms: number): NodeJS.Timeout;
  clearTimeout(timer: NodeJS.Timeout): void;
}

export type CopilotLoginOperation = LoginOperationSummary & {
  accountId: string;
  generation: number;
  pid: number | null;
  home: string;
  canceled: boolean;
  storagePromptHandled: boolean;
};

function terminal(phase: LoginPhase): boolean {
  return phase === "authenticated" || phase === "canceled" || phase === "timed_out" || phase === "failed" || phase === "interrupted";
}

function successResult(): LoginResult { return { status: "success", code: "authenticated", message: "Copilot account signed in" }; }
function failureResult(code: string, message: string): LoginResult { return { status: "failure", code, message }; }

export const realCopilotLoginPorts: CopilotLoginPorts = {
  spawn: (command, args, options) => spawn(command, args, options) as CopilotLoginChild,
  signalGroup: (child, signal) => { signalDetachedProcessGroup(child, signal); },
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setTimeout,
  clearTimeout,
};

/** Owns one device-code login at a time and exposes only the browser URL/code
    needed by the Accounts panel. Process output is never returned to callers. */
export class CopilotLoginSupervisor {
  private readonly operations = new Map<string, CopilotLoginOperation>();
  private readonly children = new Map<string, CopilotLoginChild>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly escalationTimers = new Map<string, NodeJS.Timeout>();
  private readonly handledExit = new Set<string>();
  private readonly generations = new Map<string, number>();
  private readonly output = new Map<string, string>();

  constructor(private readonly ports: CopilotLoginPorts = realCopilotLoginPorts) {}

  private update(operationId: string, patch: Partial<CopilotLoginOperation>): CopilotLoginOperation {
    const current = this.operations.get(operationId);
    if (!current) throw new Error("unknown Copilot login operation");
    const next = { ...current, ...patch };
    this.operations.set(operationId, next);
    return next;
  }

  private summary(operation: CopilotLoginOperation): LoginOperationSummary {
    const { operationId, phase, loginUrl, userCode, acceptsCode, deadlineAt, result } = operation;
    return { operationId, phase, loginUrl, userCode, acceptsCode, deadlineAt, result };
  }

  private cleanupChild(operationId: string): void {
    const timer = this.escalationTimers.get(operationId);
    if (timer) this.ports.clearTimeout(timer);
    this.escalationTimers.delete(operationId);
    this.children.delete(operationId);
  }

  private finish(operationId: string, phase: LoginPhase, result: LoginResult, retainGroup = false): CopilotLoginOperation {
    const timer = this.timers.get(operationId);
    if (timer) this.ports.clearTimeout(timer);
    this.timers.delete(operationId);
    this.output.delete(operationId);
    if (!retainGroup) this.cleanupChild(operationId);
    return this.update(operationId, { phase, result, acceptsCode: false, loginUrl: null, userCode: null });
  }

  private terminateWithEscalation(operationId: string, child: CopilotLoginChild): void {
    const deadline = this.timers.get(operationId);
    if (deadline) this.ports.clearTimeout(deadline);
    this.timers.delete(operationId);
    this.ports.signalGroup(child, "SIGTERM");
    const previous = this.escalationTimers.get(operationId);
    if (previous) this.ports.clearTimeout(previous);
    const timer = this.ports.setTimeout(() => {
      if (this.children.get(operationId) === child) {
        this.ports.signalGroup(child, "SIGKILL");
        this.cleanupChild(operationId);
      }
    }, COPILOT_LOGIN_TERM_GRACE_MS);
    this.escalationTimers.set(operationId, timer);
  }

  private capture(operationId: string, home: string, chunk: Buffer | string): void {
    const current = this.operations.get(operationId);
    if (!current || terminal(current.phase)) return;
    const clean = String(chunk).replace(ANSI, "").replace(/\r/g, "");
    const accumulated = ((this.output.get(operationId) ?? "") + clean).slice(-OUTPUT_LIMIT);
    this.output.set(operationId, accumulated);
    const urlMatch = accumulated.match(DEVICE_URL)?.[0] ?? null;
    const codeMatch = accumulated.match(USER_CODE)?.[0] ?? null;
    if (urlMatch && codeMatch && current.phase === "starting") {
      this.update(operationId, { phase: "awaiting_browser", loginUrl: "https://github.com/login/device", userCode: codeMatch, acceptsCode: false });
    }
    if (!current.storagePromptHandled && PLAINTEXT_STORAGE_PROMPT.test(accumulated)) {
      this.update(operationId, { phase: "awaiting_storage_choice", storagePromptHandled: true, loginUrl: null, userCode: null });
    }
  }

  private async onExit(operationId: string, code: number | null, home: string): Promise<void> {
    const operation = this.operations.get(operationId);
    if (!operation || this.handledExit.has(operationId)) return;
    this.handledExit.add(operationId);
    if (operation.phase === "timed_out") return;
    if (operation.canceled) {
      this.finish(operationId, "canceled", { status: "canceled", code: "canceled", message: "Copilot sign-in was canceled" }, true);
      return;
    }
    if (code !== 0) {
      this.finish(operationId, "failed", failureResult("process_failed", "Copilot sign-in did not complete"));
      return;
    }
    this.update(operationId, { phase: "verifying", loginUrl: null, userCode: null });
    const until = this.ports.now() + 5_000;
    while (this.ports.now() <= until) {
      if (copilotSignedInUser(home)) {
        this.finish(operationId, "authenticated", successResult());
        return;
      }
      await this.ports.sleep(100);
    }
    this.finish(operationId, "failed", failureResult("login_unconfirmed", "Copilot did not confirm the sign-in"));
  }

  start(accountId: string): LoginOperationSummary {
    const account = listCopilotAccounts().find((candidate) => candidate.id === accountId && candidate.kind === "managed");
    if (!account) throw new Error("choose a managed Copilot account to sign in");
    /* A retry can arrive after the launcher exited while its grandchild is
       still inside the old process group. Finish that cleanup before spawning
       another login, so both the retry UI and account state remain consistent. */
    for (const operation of this.operations.values()) {
      const child = this.children.get(operation.operationId);
      if (child && terminal(operation.phase)) {
        this.ports.signalGroup(child, "SIGKILL");
        this.cleanupChild(operation.operationId);
      }
    }
    const inProgress = [...this.operations.values()].find((operation) => !terminal(operation.phase));
    if (inProgress) throw new Error("a Copilot sign-in is already running");
    const now = this.ports.now();
    const generation = (this.generations.get(accountId) ?? 0) + 1;
    this.generations.set(accountId, generation);
    const operationId = crypto.randomUUID();
    const operation: CopilotLoginOperation = {
      operationId, accountId, phase: "starting", loginUrl: null, userCode: null, acceptsCode: false,
      deadlineAt: new Date(now + COPILOT_LOGIN_TIMEOUT_MS).toISOString(), result: null,
      pid: null, home: account.home, canceled: false, storagePromptHandled: false, generation,
    };
    this.operations.set(operationId, operation);
    try {
      const child = this.ports.spawn(resolveCopilotBinary(process.env), ["login", "--device-code"], {
        cwd: os.homedir(), env: copilotChildEnv(process.env, account.home), detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.once("error", () => {
        const live = this.operations.get(operationId);
        if (live && !terminal(live.phase)) this.finish(operationId, "failed", failureResult("process_failed", "Copilot sign-in did not complete"));
      });
      if (!child.pid) throw new Error("Copilot login process did not start");
      this.children.set(operationId, child);
      this.update(operationId, { pid: child.pid });
      child.stdout?.on("data", (chunk: Buffer) => this.capture(operationId, account.home, chunk));
      child.stderr?.on("data", (chunk: Buffer) => this.capture(operationId, account.home, chunk));
      child.once("exit", (code) => { void this.onExit(operationId, code, account.home); });
      child.once("close", (code, signal) => {
        if (!this.handledExit.has(operationId)) void this.onExit(operationId, code, account.home);
        /* A launcher can close its own stdio while an ignoring grandchild is
           still alive. Keep the group reference through the SIGKILL deadline. */
        if (!this.escalationTimers.has(operationId)) this.cleanupChild(operationId);
        this.handledExit.delete(operationId);
      });
      const timer = this.ports.setTimeout(() => {
        const live = this.operations.get(operationId);
        if (!live || terminal(live.phase)) return;
        const deadline = this.timers.get(operationId);
        if (deadline) this.ports.clearTimeout(deadline);
        this.timers.delete(operationId);
        this.output.delete(operationId);
        this.update(operationId, { phase: "timed_out", result: failureResult("timed_out", "Copilot sign-in expired"), acceptsCode: false, loginUrl: null, userCode: null });
        const child = this.children.get(operationId);
        if (child) this.terminateWithEscalation(operationId, child);
      }, COPILOT_LOGIN_TIMEOUT_MS);
      this.timers.set(operationId, timer);
      return this.summary(this.operations.get(operationId)!);
    } catch {
      this.finish(operationId, "failed", failureResult("start_failed", "Copilot sign-in could not start"));
      throw new Error("Copilot sign-in could not start");
    }
  }

  cancel(operationId: string): LoginOperationSummary {
    const operation = this.operations.get(operationId);
    if (!operation || terminal(operation.phase)) throw new Error("Copilot sign-in is not running");
    const child = this.children.get(operationId);
    if (!operation.pid || !child) throw new Error("Copilot sign-in process is unavailable");
    this.update(operationId, { phase: "canceling", canceled: true });
    try {
      this.terminateWithEscalation(operationId, child);
    } catch {
      this.finish(operationId, "failed", failureResult("process_failed", "Copilot sign-in process could not be stopped"));
    }
    return this.summary(this.operations.get(operationId)!);
  }

  choosePlaintextStorage(operationId: string, accept: boolean): LoginOperationSummary {
    const operation = this.operations.get(operationId);
    if (!operation || operation.phase !== "awaiting_storage_choice") throw new Error("Copilot login is not awaiting a storage choice");
    const child = this.children.get(operationId);
    if (!child?.stdin) throw new Error("Copilot login input is unavailable");
    child.stdin.write(accept ? "y\n" : "n\n");
    if (accept) this.update(operationId, { phase: "verifying", loginUrl: null, userCode: null });
    else this.update(operationId, { phase: "canceling", canceled: true, loginUrl: null, userCode: null });
    return this.summary(this.operations.get(operationId)!);
  }

  forAccount(accountId: string): LoginOperationSummary | null {
    const operation = [...this.operations.values()].filter((candidate) => candidate.accountId === accountId).sort((a, b) => b.generation - a.generation)[0];
    return operation ? this.summary(operation) : null;
  }

  has(operationId: string): boolean { return this.operations.has(operationId); }

  forAccounts(accountIds: readonly string[]): Map<string, LoginOperationSummary> {
    const result = new Map<string, LoginOperationSummary>();
    for (const accountId of accountIds) {
      const operation = this.forAccount(accountId);
      if (operation) result.set(accountId, operation);
    }
    return result;
  }
}

export let copilotLoginSupervisor = new CopilotLoginSupervisor();

export function setCopilotLoginSupervisorForTests(supervisor: CopilotLoginSupervisor | null): void {
  copilotLoginSupervisor = supervisor ?? new CopilotLoginSupervisor();
}
