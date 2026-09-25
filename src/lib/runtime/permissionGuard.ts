import type { EngineHost, HostState, RuntimeEvent } from "./engineHost";
import {
  ATTENDED_PERMISSION_TIMEOUT_MS,
  isClaudeToolRequest,
  isPermissionRequest,
  permissionCommandExcerpt,
  permissionDenyMessage,
  permissionDenyResolution,
  toolRequestName,
} from "./permissionRequests";

/**
 * Who answers a Claude tool request raised on a structured host (#2215).
 *
 * Claude Code asks for permission over the stdio prompt channel even under
 * `bypassPermissions` when its safety check flags a command, and a request
 * nobody answers holds the turn for ever. Two stages lost an hour each that
 * way. This guard makes sure every request gets an answer:
 *
 * - **Unattended** — a pipeline stage, or any delegated spawn (an agent's
 *   child, a review round): nobody sits at a composer there, so the request is
 *   denied at once. The deny message carries the engine's own reason verbatim
 *   and one line telling the agent to rewrite the command, and the turn goes
 *   on.
 * - **Attended** — the operator's own sessions and orchestrator seats: the
 *   request stays open for the operator (Needs-you, the conversation's card,
 *   `conversation_action permission`) and is denied the same way once it has
 *   waited {@link ATTENDED_PERMISSION_TIMEOUT_MS} unanswered.
 *
 * Attendance reads the registry's delegation record, the same notion the
 * Needs-you queue uses for a failed launch: a conversation with a pipeline
 * membership, or with a recorded delegation depth above zero, was launched by
 * the product for an agent and has no operator composer; a designated
 * orchestrator seat is attended whatever its depth.
 */

export type PermissionAttendance = "attended" | "unattended";

export interface PermissionAttendanceEvidence {
  memberships: readonly { kind: string }[];
  delegationDepth: number | null | undefined;
  /** Whether the conversation holds an orchestrator seat. */
  seat: boolean;
}

export function permissionAttendance(evidence: PermissionAttendanceEvidence): PermissionAttendance {
  if (evidence.memberships.some((membership) => membership.kind === "pipeline")) return "unattended";
  if (evidence.seat) return "attended";
  return (evidence.delegationDepth ?? 0) > 0 ? "unattended" : "attended";
}

export type PermissionDenialMode = "unattended" | "timeout";

/** One automatic deny, as the guard hands it to its recorder. */
export interface PermissionDenialRecord {
  conversationId: string;
  requestId: string;
  tool: string | null;
  command: string | null;
  reason: string | null;
  reasonType: string | null;
  mode: PermissionDenialMode;
  deniedAt: string;
}

export interface PermissionGuardDependencies {
  /** Unattended or attended; a throw reads as attended, which still denies on the timeout. */
  attendance(conversationId: string): PermissionAttendance;
  /** Records a deny the engine accepted. Failures are logged and never undo the answer. */
  record(denial: PermissionDenialRecord): void | Promise<void>;
  now?(): number;
  timeoutMs?: number;
  setTimer?(callback: () => void, delayMs: number): unknown;
  clearTimer?(timer: unknown): void;
  log?(message: string, error?: unknown): void;
}

type AnsweringHost = Pick<EngineHost, "answer">;

interface RequestFacts {
  tool: string | null;
  command: string | null;
  reason: string | null;
  reasonType: string | null;
}

/** Bound on the ids remembered as settled, so a replayed event cannot answer twice. */
const SETTLED_CAPACITY = 2_048;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function factsOf(attention: unknown): RequestFacts {
  const source = record(attention);
  return {
    tool: toolRequestName(attention),
    command: permissionCommandExcerpt(source?.input),
    reason: text(source?.decision_reason),
    reasonType: text(source?.decision_reason_type),
  };
}

export class PermissionRequestGuard {
  private readonly timers = new Map<string, unknown>();
  private readonly settled = new Set<string>();
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly log: (message: string, error?: unknown) => void;

  constructor(private readonly dependencies: PermissionGuardDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.timeoutMs = dependencies.timeoutMs ?? ATTENDED_PERMISSION_TIMEOUT_MS;
    this.setTimer = dependencies.setTimer ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    });
    this.clearTimer = dependencies.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.log = dependencies.log ?? ((message, error) => console.error(message, error ?? ""));
  }

  /** One host event. Claude tool requests are answered or timed; a resolution
      cancels the timer of the request it resolved. */
  observe(hostKey: string, host: AnsweringHost, conversationId: string, event: RuntimeEvent): void {
    if (event.kind === "attention-resolved") {
      this.cancel(hostKey, event.id);
      return;
    }
    if (event.kind !== "attention" || !isClaudeToolRequest(event.method)) return;
    this.consider(hostKey, host, conversationId, event.id, factsOf(event.attention), isPermissionRequest(event.attention), this.now());
  }

  /** The permission requests a host already holds when the guard first sees
      it: a registration that attaches after they arrived still answers them,
      counting the attended wait from when each one was raised. */
  adopt(hostKey: string, host: AnsweringHost, conversationId: string, state: Pick<HostState, "pendingPermissions">): void {
    for (const request of state.pendingPermissions ?? []) {
      const since = Date.parse(request.since);
      this.consider(hostKey, host, conversationId, request.id, {
        tool: request.tool,
        command: request.command,
        reason: request.reason,
        reasonType: request.reasonType,
      }, true, Number.isFinite(since) ? since : this.now());
    }
  }

  /** Drops every timer a released host left behind. */
  forget(hostKey: string): void {
    const prefix = `${hostKey}\u0000`;
    for (const [key, timer] of this.timers) {
      if (!key.startsWith(prefix)) continue;
      this.clearTimer(timer);
      this.timers.delete(key);
    }
  }

  /** Timers still waiting, for tests and diagnostics. */
  pendingTimers(): number {
    return this.timers.size;
  }

  private consider(
    hostKey: string,
    host: AnsweringHost,
    conversationId: string,
    requestId: string,
    facts: RequestFacts,
    permission: boolean,
    raisedAt: number,
  ): void {
    const key = `${hostKey}\u0000${requestId}`;
    if (this.settled.has(key) || this.timers.has(key)) return;
    let attendance: PermissionAttendance;
    try {
      attendance = this.dependencies.attendance(conversationId);
    } catch (error) {
      this.log("[permission guard] attendance unreadable; treating the request as attended", error);
      attendance = "attended";
    }
    if (attendance === "unattended") {
      void this.deny(key, host, conversationId, requestId, facts, "unattended");
      return;
    }
    /* A question for the operator (AskUserQuestion, a plan) is theirs to take
       as long as they need; only a permission runs out. */
    if (!permission) return;
    const delay = Math.max(0, raisedAt + this.timeoutMs - this.now());
    this.timers.set(key, this.setTimer(() => {
      this.timers.delete(key);
      void this.deny(key, host, conversationId, requestId, facts, "timeout");
    }, delay));
  }

  private cancel(hostKey: string, requestId: string): void {
    const key = `${hostKey}\u0000${requestId}`;
    const timer = this.timers.get(key);
    if (timer === undefined) return;
    this.clearTimer(timer);
    this.timers.delete(key);
  }

  private remember(key: string): void {
    this.settled.add(key);
    if (this.settled.size <= SETTLED_CAPACITY) return;
    const oldest = this.settled.values().next().value;
    if (oldest !== undefined) this.settled.delete(oldest);
  }

  private async deny(
    key: string,
    host: AnsweringHost,
    conversationId: string,
    requestId: string,
    facts: RequestFacts,
    mode: PermissionDenialMode,
  ): Promise<void> {
    if (this.settled.has(key)) return;
    this.remember(key);
    try {
      await host.answer(requestId, permissionDenyResolution(permissionDenyMessage(facts.reason)));
    } catch (error) {
      /* Answered elsewhere, cancelled with its turn, or a host that is going
         away: none of them is a deny this guard made. A replayed request that
         was settled long ago is the ordinary case and says nothing. */
      if (!(error instanceof Error && /missing or already answered/.test(error.message))) {
        this.log("[permission guard] automatic deny was not accepted", error);
      }
      return;
    }
    try {
      await this.dependencies.record({
        conversationId,
        requestId,
        ...facts,
        mode,
        deniedAt: new Date(this.now()).toISOString(),
      });
    } catch (error) {
      this.log("[permission guard] automatic deny could not be recorded", error);
    }
  }
}
