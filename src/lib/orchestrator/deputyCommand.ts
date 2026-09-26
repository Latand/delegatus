import crypto from "node:crypto";
import path from "node:path";

import type { LaunchProfile } from "@/lib/accounts/migration/contracts";
import { messageOriginRole, type MessageOrigin } from "@/lib/runtime/messageOrigin";
import type { RuntimeImageUpload } from "@/lib/runtime/runtimeImageStore";

import {
  activateDeputy,
  beginDeputy,
  endDeputy,
  readDeputies,
  recordDeputyFork,
  type DeputyAskOrigin,
  type DeputyAskSender,
  type OrchestratorDeputy,
} from "./deputies";
import { deputyMessage, type DeputyWorkContext } from "./deputyNote";
import { canonicalOrchestratorProject, type OrchestratorSeat } from "./seats";

/* «Ask in parallel» (docs/design/ghost-seat.md §5, slice 1). Each step is
 * durable before the next, and a retry under the same clientRequestId resumes
 * from the step the record says was reached: it never forks twice, never
 * registers a second conversation and never delivers twice (the delivery key is
 * derived from the record).
 *
 *   1. read the active seat; refuse `seat_not_busy` / `deputy_limit`;
 *   2. write the record as pending — the seat's feed draws the block's head;
 *   3. fork the seat's transcript into its own project directory, register the
 *      fork as a conversation with the seat's launch profile, join the seat's
 *      task, and write `artifactPath` and `forkRecordCount`;
 *   4+5. deliver the ask and the parallel note — the delivery resumes the fork
 *      under the seat's account, model, effort and grants;
 *   6. mark the record active.
 */

export type AskInParallelRefusal =
  | "invalid_request"
  | "seat_not_found"
  | "seat_not_claude"
  | "seat_not_busy"
  | "deputy_limit"
  | "fork_failed"
  | "launch_failed";

export type AskInParallelResult =
  | { ok: true; askId: string; deputyConversationId: string; replayed: boolean; deputy: OrchestratorDeputy }
  | { ok: false; code: AskInParallelRefusal; error: string; status: number; askId?: string };

export interface AskInParallelInput {
  project: string;
  text: string;
  images?: RuntimeImageUpload[];
  clientRequestId: string;
  sender?: DeputyAskSender | null;
  /** Who wrote the ask, as the route admitted it; absent is the operator. */
  origin?: DeputyAskOrigin;
}

/** The seat's newest generation, which the fork copies and whose profile it runs under. */
export interface SeatGeneration {
  engine: string;
  path: string;
  accountId: string | null;
  launchProfile: LaunchProfile;
}

export interface DeputyCommandPorts {
  now(): Date;
  activeSeat(project: string): OrchestratorSeat | null;
  seatBusy(project: string): Promise<boolean>;
  seatGeneration(seatConversationId: string): SeatGeneration | null;
  fork(input: { sourcePath: string; destination: string; sourceSessionId: string; sessionId: string; operationId: string }): { path: string; records: number | null; size?: number };
  registerConversation(input: { artifactPath: string; accountId: string | null; launchProfile: Partial<LaunchProfile> }): string;
  joinSeatTask(input: { project: string; seatConversationId: string; seatPath: string | null; deputyConversationId: string; artifactPath: string; accountId: string | null }): void;
  workContext(project: string): DeputyWorkContext;
  deliver(input: { conversationId: string; path: string; clientMessageId: string; text: string; images: RuntimeImageUpload[]; origin: DeputyAskOrigin }): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Starts the end sweep in this process (idempotent). */
  watch(): void;
  /** The store; injectable so the command is testable without a state dir. */
  store?: {
    read(): OrchestratorDeputy[];
    begin: typeof beginDeputy;
    recordFork: typeof recordDeputyFork;
    activate: typeof activateDeputy;
    end: typeof endDeputy;
  };
}

const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A long ask is still one ask; the cap keeps a pasted log out of the record. */
export const DEPUTY_ASK_LIMIT = 20_000;

/** The fork's session id, derived from the record so a replay forks to the same file. */
export function deputySessionId(askId: string): string {
  const hex = crypto.createHash("sha256").update(`deputy-session:${askId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(8 | (parseInt(hex[16]!, 16) & 3)).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The delivery key of the deputy's one message; stable across retries. */
export function deputyMessageKey(askId: string): string {
  return `deputy_ask_${crypto.createHash("sha256").update(askId).digest("hex").slice(0, 40)}`;
}

const defaultStore = {
  read: readDeputies,
  begin: beginDeputy,
  recordFork: recordDeputyFork,
  activate: activateDeputy,
  end: endDeputy,
};

/** The ask's author as the delivery ledger records it (#1117): the operator's
    own words, or an agent message carrying the role the route admitted. */
export function deputyDeliveryOrigin(origin: DeputyAskOrigin): MessageOrigin {
  if (origin.kind === "operator") return { kind: "operator" };
  const role = messageOriginRole(origin.role);
  return { kind: "agent", ...(role ? { role } : {}) };
}

function refusal(code: AskInParallelRefusal, error: string, status: number, askId?: string): AskInParallelResult {
  return { ok: false, code, error, status, ...(askId ? { askId } : {}) };
}

export async function askOrchestratorInParallel(input: AskInParallelInput, ports: DeputyCommandPorts): Promise<AskInParallelResult> {
  const store = ports.store ?? defaultStore;
  const text = typeof input.text === "string" ? input.text.trim() : "";
  const images = input.images ?? [];
  const clientRequestId = typeof input.clientRequestId === "string" ? input.clientRequestId.trim().slice(0, 128) : "";
  if (!clientRequestId) return refusal("invalid_request", "clientRequestId is required", 400);
  if (!text && !images.length) return refusal("invalid_request", "the ask is empty", 400);
  if (text.length > DEPUTY_ASK_LIMIT) return refusal("invalid_request", `the ask exceeds ${DEPUTY_ASK_LIMIT} characters`, 400);
  const project = canonicalOrchestratorProject(input.project ?? "");
  if (!project) return refusal("invalid_request", "project is required", 400);

  /* Step 1. A replay skips the busy check: the seat was busy when the record
     was written, and finishing what was started is the retry's whole job. */
  const replay = store.read().find((deputy) => deputy.clientRequestId === clientRequestId) ?? null;
  const seat = ports.activeSeat(project);
  if (!seat?.conversationId) return refusal("seat_not_found", `no orchestrator seat is active for ${project}`, 404);
  const generation = ports.seatGeneration(seat.conversationId);
  if (!generation || generation.engine !== "claude") {
    return refusal("seat_not_claude", "asking in parallel works for a Claude seat only in this version", 409);
  }
  let deputy: OrchestratorDeputy;
  if (replay) {
    deputy = replay;
  } else {
    if (!(await ports.seatBusy(project))) {
      return refusal("seat_not_busy", "the orchestrator is not working on anything now; send the message to it directly", 409);
    }
    /* Step 2. */
    const begun = store.begin({
      project,
      seatConversationId: seat.conversationId,
      seatEpoch: seat.seatEpoch,
      seatPath: seat.path ?? generation.path,
      clientRequestId,
      ask: { text, images: images.length, sender: input.sender ?? null, origin: input.origin ?? { kind: "operator" } },
      now: ports.now(),
    });
    if (begun.kind === "limit") {
      return refusal("deputy_limit", "the orchestrator's parallel self is already working on another message; wait for it to finish", 409, begun.deputy.askId);
    }
    deputy = begun.deputy;
  }
  if (deputy.state === "ended") {
    return deputy.deputyConversationId && deputy.outcome !== "failed"
      ? { ok: true, askId: deputy.askId, deputyConversationId: deputy.deputyConversationId, replayed: true, deputy }
      : refusal(deputy.error?.startsWith("fork") ? "fork_failed" : "launch_failed", deputy.error ?? "the parallel self did not start", 409, deputy.askId);
  }

  /* Step 3. */
  if (!deputy.deputyConversationId || !deputy.artifactPath || deputy.forkRecordCount === null) {
    const sourceSessionId = path.basename(generation.path, ".jsonl");
    const sessionId = deputySessionId(deputy.askId);
    if (!CLAUDE_SESSION_ID.test(sourceSessionId)) {
      store.end(deputy.askId, { outcome: "failed", error: "fork: the seat's transcript has no Claude session id", now: ports.now() });
      return refusal("fork_failed", "the seat's transcript cannot be forked", 409, deputy.askId);
    }
    let forked: { path: string; records: number | null; size?: number };
    try {
      forked = ports.fork({
        sourcePath: generation.path,
        destination: path.join(path.dirname(generation.path), `${sessionId}.jsonl`),
        sourceSessionId,
        sessionId,
        operationId: `deputy:${deputy.askId}`,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      store.end(deputy.askId, { outcome: "failed", error: `fork: ${reason}`, now: ports.now() });
      return refusal("fork_failed", `the seat's transcript could not be forked: ${reason}`, 409, deputy.askId);
    }
    if (forked.records === null) {
      store.end(deputy.askId, { outcome: "failed", error: "fork: the copy did not report its length", now: ports.now() });
      return refusal("fork_failed", "the seat's transcript could not be forked", 409, deputy.askId);
    }
    const launchProfile: Partial<LaunchProfile> = {
      ...generation.launchProfile,
      /* Everything that reaches the provider — model, effort, grants, tools —
         is the seat's, so the first request reads the seat's prompt cache. */
      parentConversationId: seat.conversationId as LaunchProfile["parentConversationId"],
      title: "Orchestrator · parallel self",
      goal: null,
      plan: null,
    };
    const deputyConversationId = ports.registerConversation({ artifactPath: forked.path, accountId: generation.accountId, launchProfile });
    ports.joinSeatTask({
      project,
      seatConversationId: seat.conversationId,
      seatPath: seat.path ?? generation.path,
      deputyConversationId,
      artifactPath: forked.path,
      accountId: generation.accountId,
    });
    deputy = store.recordFork(deputy.askId, { deputyConversationId, artifactPath: forked.path, forkRecordCount: forked.records, forkBytes: forked.size ?? null }) ?? deputy;
  }

  /* Steps 4 and 5: one delivery, keyed by the record, resumes the fork. */
  if (deputy.state === "pending") {
    const delivered = await ports.deliver({
      conversationId: deputy.deputyConversationId!,
      path: deputy.artifactPath!,
      clientMessageId: deputyMessageKey(deputy.askId),
      text: deputyMessage({ ask: deputy.ask.text, seatConversationId: deputy.seatConversationId, context: ports.workContext(project) }),
      images,
      /* The record's origin, so a replay delivers under the author the first
         request was admitted as. */
      origin: deputy.ask.origin,
    });
    if (!delivered.ok) {
      store.end(deputy.askId, { outcome: "failed", error: `launch: ${delivered.error}`, now: ports.now() });
      return refusal("launch_failed", `the parallel self could not start: ${delivered.error}`, 409, deputy.askId);
    }
    /* Step 6. */
    deputy = store.activate(deputy.askId, ports.now()) ?? deputy;
  }
  ports.watch();
  return { ok: true, askId: deputy.askId, deputyConversationId: deputy.deputyConversationId!, replayed: replay !== null, deputy };
}
