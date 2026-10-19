import { statePath } from "@/lib/configDir";
import { StateLockDeferredError, waitForStateLock } from "@/lib/state/lockWait";
import { RuntimeImageStore, RuntimeImageWriterBusyError } from "@/lib/runtime/runtimeImageStore";
import { tryConversationActuation } from "@/lib/deliveryActuation";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { withAccountMutationLockAsync } from "@/lib/accounts/accountMutation";
import crypto from "node:crypto";
import path from "node:path";

import type { LaunchProfile } from "@/lib/accounts/migration/contracts";
import { messageOriginRole, type MessageOrigin } from "@/lib/runtime/messageOrigin";
import type { StructuredImageRef } from "@/lib/runtime/structuredContent";
import type { RuntimeImageUpload } from "@/lib/runtime/runtimeImageStore";

import {
  recordDeputyDelivery,
  retryDeputy,
  activateDeputy,
  beginDeputy,
  deputyMessageKey,
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
  | {
    ok: true;
    askId: string;
    deputyConversationId: string;
    replayed: boolean;
    deputy: OrchestratorDeputy;
    /** The runtime may have taken the ask without acknowledging it in time:
        the record stays pending and the sweep settles it from runtime facts. */
    deliveryUncertain?: true;
  }
  | { ok: false; code: AskInParallelRefusal; error: string; status: number; askId?: string; admission?: "refused" };

export interface RetryDeputyInput { retryAskId: string; clientRequestId: string }

export interface AskInParallelInput {
  project: string;
  seatConversationId?: string;
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
  registerConversation(input: { artifactPath: string; accountId: string | null; launchProfile: Partial<LaunchProfile>; assertCurrent?: () => void }): string | Promise<string>;
  joinSeatTask(input: { project: string; seatConversationId: string; seatPath: string | null; deputyConversationId: string; artifactPath: string; accountId: string | null }): void | Promise<void>;
  workContext(project: string): DeputyWorkContext;
  deliver(input: { conversationId: string; path: string; clientMessageId: string; text: string; images: RuntimeImageUpload[]; origin: DeputyAskOrigin }): Promise<{ ok: true; outcome?: string; operationId?: string } | { ok: false; error: string; operationId?: string; uncertain?: true }>;
  imageRefsForRetry?(deputy: OrchestratorDeputy): StructuredImageRef[];
  prepareRetry?(deputy: OrchestratorDeputy, guard: () => void): Promise<{ ok: true; completed?: OrchestratorDeputy } | { ok: false; error: string }>;
  /** Recheck a fork's transcript at the serialized retry commit boundary. */
  reconcileRetryAnswer?(deputy: OrchestratorDeputy): OrchestratorDeputy | null;
  /** Starts the end sweep in this process (idempotent). */
  watch(): void;
  /** The store; injectable so the command is testable without a state dir. */
  store?: {
    read(): OrchestratorDeputy[];
    begin: typeof beginDeputy;
    recordFork: typeof recordDeputyFork;
    activate: typeof activateDeputy;
    end: typeof endDeputy;
    recordDelivery?: typeof recordDeputyDelivery;
    retry?: typeof retryDeputy;
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

export { deputyMessageKey };

const defaultStore = {
  recordDelivery: recordDeputyDelivery,
  retry: retryDeputy,
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

function refusal(code: AskInParallelRefusal, error: string, status: number, askId?: string, admissionRefused = false): AskInParallelResult {
  return { ok: false, code, error, status, ...(askId ? { askId } : {}), ...(admissionRefused ? { admission: "refused" as const } : {}) };
}

/* Overlapping calls under one key join the call already running, so one ask
   forks once and delivers once: the second would otherwise read the pending
   record the first just wrote and race it to the same fork destination. On
   globalThis because each route bundle carries its own copy of this module. */
const IN_FLIGHT_KEY = Symbol.for("llv.orchestrator.deputyAsksInFlight");
function asksInFlight(): Map<string, Promise<AskInParallelResult>> {
  const holder = globalThis as typeof globalThis & { [IN_FLIGHT_KEY]?: Map<string, Promise<AskInParallelResult>> };
  return holder[IN_FLIGHT_KEY] ??= new Map();
}

export function askOrchestratorInParallel(input: AskInParallelInput | RetryDeputyInput, ports: DeputyCommandPorts): Promise<AskInParallelResult> {
  const key = typeof input.clientRequestId === "string" ? input.clientRequestId.trim().slice(0, 128) : "";
  const run = () => withViewerOperation("orchestrator.deputy", () => "retryAskId" in input ? retryOnce(input, ports) : askOnce(input, ports));
  if (!key) return run();
  const inFlight = asksInFlight();
  const running = inFlight.get(key);
  if (running) return running.then((result) => result.ok ? { ...result, replayed: true } : result);
  const started = run().finally(() => {
    if (inFlight.get(key) === started) inFlight.delete(key);
  });
  inFlight.set(key, started);
  return started;
}

async function deputyImages<T>(operation: (store: RuntimeImageStore) => T): Promise<T> {
  return waitForStateLock("deputy.images", () => {
    try { return operation(new RuntimeImageStore(statePath("runtime-images"), { writerLockWaitMs: 0 })); }
    catch (error) { if (error instanceof RuntimeImageWriterBusyError) throw new StateLockDeferredError("deputy.images", "lease"); throw error; }
  });
}

async function retryOnce(input: RetryDeputyInput, ports: DeputyCommandPorts): Promise<AskInParallelResult> {
  const store = ports.store ?? defaultStore;
  input = { retryAskId: input.retryAskId, clientRequestId: typeof input.clientRequestId === "string" ? input.clientRequestId.trim().slice(0, 128) : "" };
  const previous = store.read().find(row => row.askId === input.retryAskId);
  const fail = (error: string) => refusal("launch_failed", error, 409, input.retryAskId);
  if (!previous || !input.clientRequestId?.trim()) return fail("the saved parallel question is unavailable");
  const sameSeat = () => {
    const seat = ports.activeSeat(previous.project);
    return seat?.conversationId === previous.seatConversationId && seat.seatEpoch === previous.seatEpoch;
  };
  if (!sameSeat()) return fail("the orchestrator seat changed; send the question to its current seat");
  if (previous.retryRequestId !== input.clientRequestId) {
    if (previous.state !== "ended" || previous.outcome === "done" || previous.outcome === "seat-rotated") return fail("this parallel question is not awaiting retry");
    const imageRefs = previous.ask.images === (previous.imageRefs?.length ?? 0)
      ? previous.imageRefs ?? [] : ports.imageRefsForRetry?.(previous) ?? [];
    if (previous.ask.images !== imageRefs.length) return fail("the saved attachment is unavailable; attach it again");
    try { if (imageRefs.length) await deputyImages(store => imageRefs.map(ref => store.read(ref))); }
    catch { return fail("the saved attachment could not be read; the question is kept here"); }
    if (!ports.prepareRetry) return fail("the previous delivery cannot be checked");
    // Refuse a concurrent actuator instead of waiting behind its host read.
    const prepare = async () => {
      const guard = () => {
        const current = store.read().find(row => row.askId === previous.askId);
        if (!sameSeat() || !current || current.state !== "ended" || (current.attempt ?? 0) !== (previous.attempt ?? 0)) {
          throw new Error("the parallel question changed while checking its previous delivery");
        }
      };
      guard();
      const settled = await ports.prepareRetry!(previous, guard);
      if (!settled.ok) return settled;
      if (settled.completed) return { ok: true as const, completed: settled.completed };
      let answerFromBytes: number | undefined;
      if (previous.artifactPath) {
        const fs = await import("node:fs");
        try { answerFromBytes = fs.statSync(previous.artifactPath).size; } catch { /* A fork that never wrote has no prefix. */ }
      }
      const reopened = await withAccountMutationLockAsync(() => {
        if (!sameSeat()) return { kind: "changed" as const };
        const current = store.read().find(row => row.askId === previous.askId);
        if (!current || current.state !== "ended" || (current.attempt ?? 0) !== (previous.attempt ?? 0)) {
          return { kind: "changed" as const };
        }
        const completed = ports.reconcileRetryAnswer?.(current);
        if (completed) return { kind: "completed" as const, deputy: completed };
        const retried = (store.retry ?? retryDeputy)(previous.askId, input.clientRequestId,
          previous.attempt ?? 0, ports.now(), answerFromBytes, imageRefs);
        return retried ? { kind: "reopened" as const } : { kind: "changed" as const };
      },
      { caller: "deputy retry" });
      return reopened.kind === "completed"
        ? { ok: true as const, completed: reopened.deputy }
        : reopened.kind === "reopened" ? { ok: true as const }
          : { ok: false as const, error: "the parallel question changed while retrying" };
    };
    const attempt = previous.deputyConversationId ? await tryConversationActuation(previous.deputyConversationId, prepare)
      : { acquired: true as const, value: await prepare() };
    if (!attempt.acquired) return fail("the previous delivery is still being checked; retry shortly");
    if (!attempt.value.ok) return fail(attempt.value.error);
    if (attempt.value.completed) {
      ports.watch();
      const completed = attempt.value.completed;
      return { ok: true, askId: completed.askId, deputyConversationId: completed.deputyConversationId!, replayed: true, deputy: completed };
    }
  }
  return askOnce({ project: previous.project, seatConversationId: previous.seatConversationId,
    text: previous.ask.text, clientRequestId: previous.clientRequestId }, ports);
}

async function askOnce(input: AskInParallelInput, ports: DeputyCommandPorts): Promise<AskInParallelResult> {
  const store = ports.store ?? defaultStore;
  let text = typeof input.text === "string" ? input.text.trim() : "";
  let images = input.images ?? [];
  const clientRequestId = typeof input.clientRequestId === "string" ? input.clientRequestId.trim().slice(0, 128) : "";
  const replay = clientRequestId ? store.read().find((deputy) => deputy.clientRequestId === clientRequestId) ?? null : null;
  if (replay) {
    text = replay.ask.text;
    if (replay.ask.images !== (replay.imageRefs?.length ?? 0)) return refusal("launch_failed", "the saved attachment is unavailable; attach it again", 409, replay.askId);
    images = replay.ask.images ? await deputyImages(store => (replay.imageRefs ?? []).map(ref => ({ mime: ref.mime, base64: store.read(ref).toString("base64") }))) : [];
  }
  // A replay can already own a fork or delivery. Only a fresh ask refused
  // before begin supplies affirmative evidence that it admitted no work.
  const refuseAdmission = (code: AskInParallelRefusal, error: string, status: number, askId?: string) =>
    refusal(code, error, status, replay?.askId ?? askId, replay === null);
  if (!clientRequestId) return refuseAdmission("invalid_request", "clientRequestId is required", 400);
  if (!text && !images.length) return refuseAdmission("invalid_request", "the ask is empty", 400);
  if (text.length > DEPUTY_ASK_LIMIT) return refuseAdmission("invalid_request", `the ask exceeds ${DEPUTY_ASK_LIMIT} characters`, 400);
  const project = canonicalOrchestratorProject(input.project ?? "");
  if (!project) return refuseAdmission("invalid_request", "project is required", 400);

  /* Step 1. A replay skips the busy check: the seat was busy when the record
     was written, and finishing what was started is the retry's whole job. */
  const seat = ports.activeSeat(project);
  if (!seat?.conversationId) return refuseAdmission("seat_not_found", `no orchestrator seat is active for ${project}`, 404);
  const seatConversationId = seat.conversationId;
  if (input.seatConversationId && input.seatConversationId !== seat.conversationId) {
    return refuseAdmission("seat_not_found", "the orchestrator seat changed; reopen its conversation", 409);
  }
  const generation = ports.seatGeneration(seat.conversationId);
  if (!generation || generation.engine !== "claude") {
    return refuseAdmission("seat_not_claude", "asking in parallel works for a Claude seat only in this version", 409);
  }
  let deputy: OrchestratorDeputy;
  let replayed = replay !== null;
  if (replay) {
    deputy = replay;
  } else {
    const busy = await ports.seatBusy(project);
    const currentSeat = ports.activeSeat(project);
    if (currentSeat?.conversationId !== seat.conversationId || currentSeat.seatEpoch !== seat.seatEpoch) {
      return refuseAdmission("seat_not_found", "the orchestrator seat changed; reopen its conversation", 409);
    }
    if (!busy) {
      return refuseAdmission("seat_not_busy", "the orchestrator is not working on anything now; send the message to it directly", 409);
    }
    const imageRefs = images.length ? await deputyImages(store => store.putMany(images)) : [];
    /* Step 2. */
    const begun = await withAccountMutationLockAsync(() => {
      // Admission may have queued behind a rotation; recheck the same epoch.
      const admittedSeat = ports.activeSeat(project);
      if (admittedSeat?.conversationId !== seat.conversationId || admittedSeat.seatEpoch !== seat.seatEpoch) return null;
      return store.begin({
        project,
        seatConversationId,
        seatEpoch: seat.seatEpoch,
        seatPath: seat.path ?? generation.path,
        clientRequestId,
        imageRefs,
        ask: { text, images: images.length, sender: input.sender ?? null, origin: input.origin ?? { kind: "operator" } },
        now: ports.now(),
      });
    }, { caller: "deputy begin" });
    if (!begun) return refuseAdmission("seat_not_found", "the orchestrator seat changed; reopen its conversation", 409);
    if (begun.kind === "limit") {
      return refuseAdmission("deputy_limit", "the orchestrator's parallel self is already working on another message; wait for it to finish", 409, begun.deputy.askId);
    }
    /* A record written under this key after the pre-read (another process)
       is the same ask: finished from the step it reached, like any replay. */
    replayed = begun.kind === "replay";
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
      await withAccountMutationLockAsync(() => store.end(deputy.askId, { outcome: "failed", expectedAttempt: deputy.attempt ?? 0, error: "fork: the seat's transcript has no Claude session id", now: ports.now() }), { caller: "deputy end" });
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
      await withAccountMutationLockAsync(() => store.end(deputy.askId, { outcome: "failed", expectedAttempt: deputy.attempt ?? 0, error: `fork: ${reason}`, now: ports.now() }), { caller: "deputy end" });
      return refusal("fork_failed", `the seat's transcript could not be forked: ${reason}`, 409, deputy.askId);
    }
    if (forked.records === null) {
      await withAccountMutationLockAsync(() => store.end(deputy.askId, { outcome: "failed", expectedAttempt: deputy.attempt ?? 0, error: "fork: the copy did not report its length", now: ports.now() }), { caller: "deputy end" });
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
    const deputyConversationId = await ports.registerConversation({ artifactPath: forked.path, accountId: generation.accountId, launchProfile, assertCurrent: () => {
      const current = ports.activeSeat(project);
      if (current?.conversationId !== deputy.seatConversationId || current.seatEpoch !== deputy.seatEpoch) throw new Error("orchestrator seat changed before deputy registration");
    } });
    const forkRecordCount = forked.records;
    deputy = await withAccountMutationLockAsync(() => store.recordFork(deputy.askId, { deputyConversationId, artifactPath: forked.path, forkRecordCount, forkBytes: forked.size ?? null }), { caller: "deputy commit" }) ?? deputy;
  }

  /* Steps 4 and 5: one delivery, keyed by the record, resumes the fork. */
  if (deputy.state === "pending") {
    try {
      await ports.joinSeatTask({ project, seatConversationId: deputy.seatConversationId,
        seatPath: deputy.seatPath, deputyConversationId: deputy.deputyConversationId!,
        artifactPath: deputy.artifactPath!, accountId: generation.accountId });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await withAccountMutationLockAsync(() => store.end(deputy.askId, { outcome: "failed", expectedAttempt: deputy.attempt ?? 0,
        error: `launch: ${reason}`, now: ports.now() }), { caller: "deputy membership refusal" });
      return refusal("launch_failed", reason, 503, deputy.askId);
    }
    const currentSeat = ports.activeSeat(project);
    if (currentSeat?.conversationId !== deputy.seatConversationId || currentSeat.seatEpoch !== deputy.seatEpoch) {
      await withAccountMutationLockAsync(() => store.end(deputy.askId, { outcome: "seat-rotated", expectedAttempt: deputy.attempt ?? 0,
        error: "the orchestrator seat changed before delivery", now: ports.now() }), { caller: "deputy seat change" });
      return refusal("seat_not_found", "the orchestrator seat changed before delivery", 409, deputy.askId);
    }
    const deliveryAttempt = deputy.attempt ?? 0;
    const delivered = await ports.deliver({
      conversationId: deputy.deputyConversationId!,
      path: deputy.artifactPath!,
      clientMessageId: deputyMessageKey(deputy.askId, deputy.attempt ?? 0),
      text: deputyMessage({ ask: deputy.ask.text, seatConversationId: deputy.seatConversationId, context: ports.workContext(project) }),
      images,
      /* The record's origin, so a replay delivers under the author the first
         request was admitted as. */
      origin: deputy.ask.origin,
    });
    deputy = await withAccountMutationLockAsync(() => (store.recordDelivery ?? recordDeputyDelivery)(deputy.askId, {
      operationId: delivered.operationId ?? null, outcome: delivered.ok ? delivered.outcome ?? "delivered" : delivered.uncertain ? "uncertain" : "failed",
      reason: delivered.ok ? null : delivered.error,
    }, deliveryAttempt), { caller: "deputy delivery" }) ?? deputy;
    if ((deputy.attempt ?? 0) !== deliveryAttempt || deputy.state !== "pending") {
      ports.watch();
      return { ok: true, askId: deputy.askId, deputyConversationId: deputy.deputyConversationId!, replayed, deputy };
    }
    if (delivered.ok && delivered.outcome && !["delivered", "delivered-to-live", "resumed"].includes(delivered.outcome)) {
      ports.watch();
      return { ok: true, askId: deputy.askId, deputyConversationId: deputy.deputyConversationId!, replayed, deputy };
    }
    if (!delivered.ok && delivered.uncertain) {
      /* The runtime may be running the ask. Ending the record here would take
         the ghost's authority away while it works and leave its host to no
         one, since the sweep releases no failed record. Pending, it is
         settled like a lost activation: done once it answers, or interrupted
         and released at expiry; a replay under this key redelivers once. */
      ports.watch();
      return { ok: true, askId: deputy.askId, deputyConversationId: deputy.deputyConversationId!, replayed, deputy, deliveryUncertain: true };
    }
    if (!delivered.ok) {
      await withAccountMutationLockAsync(() => store.end(deputy.askId, { outcome: "failed", expectedAttempt: deputy.attempt ?? 0, error: `launch: ${delivered.error}`, now: ports.now() }), { caller: "deputy end" });
      return refusal("launch_failed", `the parallel self could not start: ${delivered.error}`, 409, deputy.askId);
    }
    /* Step 6. */
    deputy = await withAccountMutationLockAsync(() => store.activate(deputy.askId, ports.now(), deliveryAttempt), { caller: "deputy commit" }) ?? deputy;
  }
  ports.watch();
  return { ok: true, askId: deputy.askId, deputyConversationId: deputy.deputyConversationId!, replayed, deputy };
}
