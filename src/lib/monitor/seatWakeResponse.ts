import crypto from "node:crypto";
import { seatTickWorkSignal } from "./seatTickWork";
import { parseMessageOrigin, type MessageOrigin } from "@/lib/runtime/messageOrigin";
import { agentRegistry } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { lookupOriginalSend } from "@/lib/runtime/sendSettlement";
import { runtimeHostClient } from "@/lib/runtime/client";
import { meaningfulModelProgress, turnSilenceProgress } from "@/lib/runtime/turnSilence";
import { captureRuntimeEventPosition, normalizeRuntimeEventPosition, readRuntimeEventPage, type RuntimeEventPosition } from "@/lib/runtime/eventStore";

export interface SeatWakeResponse {
  clientMessageId: string;
  operationId: string;
  conversationId: string;
  seatEpoch: number;
  /** Original wake admission, retained independently of transport arrival. */
  preparedAt?: string;
  deliveredAt: string;
  boundMs: number;
  progressAt: string;
  turnId?: string;
  generationId?: string;
  scanFrom?: WakeResponseStart;
  scan?: WakeResponseCheckpoint[];
  recovery?: { text: string; origin: MessageOrigin };
  action: "pending" | "nudging" | "nudged";
}
export interface WakeResponseEvidence {
  answered: boolean;
  providerFailure?: boolean;
  /** The bound input's latest native turn conclusively ended. */
  terminal?: boolean;
  turnId?: string;
  generationId?: string;
  progressAt?: string;
  wait?: string;
  scan?: WakeResponseCheckpoint[];
}

interface ResponseReduction {
  turnId?: string;
  progressAt?: string;
  terminal: boolean;
  continuation: boolean;
  replied: boolean;
  providerFailure: boolean;
  inputBound: boolean;
}

const RESPONSE_REPLAY_TICK_BYTES = 8 * 1024 * 1024;

export interface WakeResponseStart {
  generationId: string;
  position: RuntimeEventPosition;
}

export interface WakeResponseCheckpoint extends WakeResponseStart {
  identity: string;
  binding: string;
  nativeTurns: Array<[string, boolean]>;
  fromPreparation: boolean;
  reduction: ResponseReduction;
}

export function matchingWakeResponseCheckpoint(checkpoints: WakeResponseCheckpoint[] | undefined, generationId: string,
  identity: string, binding: string, receiptUnavailable: boolean, nativeTurns?: Iterable<string>): WakeResponseCheckpoint | undefined {
  const prior = checkpoints?.find(entry => entry.generationId === generationId && entry.identity === identity);
  const expanded = prior && nativeTurns && [...nativeTurns].some(turnId => !prior.nativeTurns.some(([known]) => known === turnId));
  return prior && !expanded && (prior.binding === binding || receiptUnavailable) ? prior : undefined;
}

export function normalizeWakeResponseStart(value: unknown): WakeResponseStart | undefined {
  const row = value as WakeResponseStart | null;
  if (!row || typeof row.generationId !== "string" || !row.generationId) return;
  const position = normalizeRuntimeEventPosition(row.position);
  if (position) return { generationId: row.generationId, position };
}

function normalizeCheckpoints(value: unknown): WakeResponseCheckpoint[] | undefined {
  if (!Array.isArray(value)) return;
  return value.slice(0, 4).flatMap((item: WakeResponseCheckpoint | null) => {
    const start = normalizeWakeResponseStart(item);
    if (!start || !item || typeof item.binding !== "string" || !/^[a-f0-9]{64}$/.test(item.binding)
      || typeof item.identity !== "string" || !/^[a-f0-9]{64}$/.test(item.identity)
      || !Array.isArray(item.nativeTurns) || item.nativeTurns.some(entry => !Array.isArray(entry) || entry.length !== 2
        || typeof entry[0] !== "string" || !entry[0] || typeof entry[1] !== "boolean")
      || typeof item.fromPreparation !== "boolean") return [];
    const reduction = item.reduction;
    if (!reduction || [reduction.terminal, reduction.continuation, reduction.replied, reduction.providerFailure, reduction.inputBound].some(flag => typeof flag !== "boolean")
      || (reduction.turnId !== undefined && (typeof reduction.turnId !== "string" || !reduction.turnId))
      || (reduction.progressAt !== undefined && !Number.isFinite(Date.parse(reduction.progressAt)))) return [];
    const { turnId, progressAt, terminal, continuation, replied, providerFailure, inputBound } = reduction;
    return [{ ...start, identity: item.identity, binding: item.binding,
      nativeTurns: [...new Map(item.nativeTurns.map(([turn, continuation]) => [turn, continuation] as const))], fromPreparation: item.fromPreparation,
      reduction: { terminal, continuation, replied, providerFailure, inputBound, ...(turnId ? { turnId } : {}), ...(progressAt ? { progressAt } : {}) } }];
  });
}

export async function captureSeatWakeResponseStart(conversationId: string): Promise<WakeResponseStart | undefined> {
  try {
    const generation = agentRegistry().conversation(conversationId as ViewerConversationId)?.generations.at(-1);
    if (!generation) return;
    const position = await captureRuntimeEventPosition(generation.id);
    if (position) return { generationId: generation.id, position };
  } catch { seatTickWorkSignal()?.throwIfAborted(); }
}

export const seatWakeResponseBound = (checkMs: number, wakeMs: number) => Math.max(2 * checkMs, Math.min(wakeMs, 15 * 60_000));
export const wakeResponseRecoveryKey = (row: SeatWakeResponse) => `seat-response-${crypto.createHash("sha256").update(JSON.stringify([row.conversationId, row.seatEpoch, row.clientMessageId])).digest("hex")}`;
export function normalizeSeatWakeResponse(value: unknown): SeatWakeResponse | undefined {
  const row = value as SeatWakeResponse | null;
  return row && typeof row.clientMessageId === "string" && !!row.clientMessageId
    && typeof row.operationId === "string" && !!row.operationId && typeof row.conversationId === "string" && !!row.conversationId
    && Number.isSafeInteger(row.seatEpoch) && row.seatEpoch >= 0
    && (row.preparedAt === undefined || Number.isFinite(Date.parse(row.preparedAt)) && Date.parse(row.preparedAt) <= Date.parse(row.deliveredAt))
    && Number.isFinite(Date.parse(row.deliveredAt)) && Number.isFinite(Date.parse(row.progressAt))
    && (row.turnId === undefined || typeof row.turnId === "string" && !!row.turnId)
    && (row.generationId === undefined || typeof row.generationId === "string" && !!row.generationId)
    && (row.recovery === undefined || row.recovery && typeof row.recovery.text === "string" && !!parseMessageOrigin(row.recovery.origin))
    && Number.isFinite(row.boundMs) && row.boundMs > 0 && ["pending", "nudging", "nudged"].includes(row.action)
    ? { ...row, ...(row.scanFrom === undefined ? {} : { scanFrom: normalizeWakeResponseStart(row.scanFrom) }),
      ...(row.scan === undefined ? {} : { scan: normalizeCheckpoints(row.scan) }) } : undefined;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

/** Replay the delivered input's own generation in bounded pages. An exact
 * input/turn witness is required; a newer unrelated turn grants nothing. */
export async function observeSeatWakeResponse(row: SeatWakeResponse, project?: string): Promise<WakeResponseEvidence> {
  try { return await readSeatWakeResponse(row, project); }
  catch {
    seatTickWorkSignal()?.throwIfAborted();
    return { answered: false, wait: "response ownership evidence unavailable" };
  }
}
async function readSeatWakeResponse(row: SeatWakeResponse, project?: string): Promise<WakeResponseEvidence> {
  const registry = agentRegistry();
  await registry.prepareRecoveryIndexes(seatTickWorkSignal());
  const conversation = registry.conversation(row.conversationId as ViewerConversationId);
  if (!conversation) return { answered: false, wait: "response ownership evidence unavailable" };
  type Binding = { operationId: string; generationId?: string | null; batchId?: string; nativeTurnId?: string };
  const findBinding = (key: string, payload?: SeatWakeResponse["recovery"]): Binding | null => {
    const file = registry.deliverySnapshotForMessageKey(row.conversationId, key);
    const found = lookupOriginalSend(file, { conversationId: row.conversationId, clientMessageId: key,
      ...(payload ? { text: payload.text, origin: payload.origin } : {}) });
    if (found.kind !== "found") return null;
    const delivery = found.deliveryId ? file.heldDeliveries[found.deliveryId] : undefined;
    const owner = file.deliveryOperationOwners[found.operationId];
    return { operationId: found.operationId, generationId: delivery?.generationId ?? owner?.targetGenerationId,
      ...(owner?.batchId ? { batchId: owner.batchId } : {}),
      ...(found.receipt.state === "delivered" && found.receipt.turnId ? { nativeTurnId: found.receipt.turnId } : {}) };
  };
  const foundOriginal = findBinding(row.clientMessageId);
  const original: Binding = { operationId: foundOriginal?.operationId ?? row.operationId,
    generationId: foundOriginal?.generationId ?? row.generationId, ...(foundOriginal?.batchId ? { batchId: foundOriginal.batchId } : {}),
    ...(foundOriginal?.nativeTurnId ? { nativeTurnId: foundOriginal.nativeTurnId } : {}) };
  const { readSeatQuotaObligation } = await import("./seatQuotaRecovery");
  const quota = project ? readSeatQuotaObligation(project) : null;
  const quotaContinuation = quota && (quota.original.operationId === original.operationId || quota.original.operationId === row.operationId
    || quota.original.clientMessageId === wakeResponseRecoveryKey(row)) ? findBinding(quota.id) : null;
  const recovery = row.action !== "pending" && row.recovery ? findBinding(wakeResponseRecoveryKey(row), row.recovery) : null;
  const recoveryBindings = [quotaContinuation, recovery].filter((value): value is Binding => value !== null);
  const bindings: Binding[] = [...recoveryBindings, original];
  // Keep previously proven native membership even after receipt compaction.
  if (row.operationId !== original.operationId || row.generationId && row.turnId) {
    bindings.push({ operationId: row.operationId, generationId: row.generationId ?? original.generationId,
      nativeTurnId: row.generationId ? row.turnId : undefined });
  }
  const client = runtimeHostClient();
  const signal = seatTickWorkSignal();
  const generations = new Map<string, ResponseMembership>();
  let wait: string | undefined;
  for (const binding of bindings) {
    const generation = binding.generationId
      ? conversation.generations.find(candidate => candidate.id === binding.generationId) : conversation.generations.at(-1);
    if (!generation) { wait = "Delivered input generation evidence is unavailable."; continue; }
    let membership = generations.get(generation.id);
    if (!membership) {
      membership = { operations: new Map(), nativeTurns: new Map(), receiptUnavailable: false };
      generations.set(generation.id, membership);
    }
    const continuation = recoveryBindings.includes(binding);
    for (const id of [binding.operationId, binding.batchId]) {
      if (id) membership.operations.set(id, continuation || membership.operations.get(id) === true);
    }
    let nativeTurnId = binding.nativeTurnId;
    if (!nativeTurnId) try {
      const result = await client?.operationStatus(binding.operationId, { signal });
      if (result?.operationId === binding.operationId && result.receipt.conversationId === row.conversationId
        && ["delivered", "applied", "answered"].includes(result.receipt.status) && result.receipt.turnId) nativeTurnId = result.receipt.turnId;
      else membership.receiptUnavailable = true;
    } catch { membership.receiptUnavailable = true; /* Native event membership remains independently readable. */ }
    if (nativeTurnId) membership.nativeTurns.set(nativeTurnId, continuation || membership.nativeTurns.get(nativeTurnId) === true);
  }
  const scan: WakeResponseCheckpoint[] = [];
  let latest: WakeResponseEvidence | undefined;
  const newestFirst = [...generations].sort(([left], [right]) =>
    conversation.generations.findIndex(generation => generation.id === right) - conversation.generations.findIndex(generation => generation.id === left));
  for (const [generationId, membership] of newestFirst) {
    // A changed receipt, batch, or recovery key may make earlier events
    // relevant. Reuse reductions only for the same obligation and bindings.
    const identity = crypto.createHash("sha256").update(JSON.stringify([row.conversationId, row.seatEpoch, row.clientMessageId,
      [...membership.operations].sort()])).digest("hex");
    const prior = row.scan?.find(entry => entry.generationId === generationId && entry.identity === identity);
    // A transient receipt timeout removes optional native-turn evidence. Keep
    // the durable cursor and reducer in that case; a newly observed turn id
    // changes the binding and requires replay from the beginning.
    const missingReceipt = membership.receiptUnavailable;
    const learnedTurn = [...membership.nativeTurns.keys()].some(turnId => !prior?.nativeTurns.some(([known]) => known === turnId));
    if (missingReceipt && prior && !learnedTurn) for (const [turnId, continuation] of prior.nativeTurns) membership.nativeTurns.set(turnId, continuation);
    const binding = crypto.createHash("sha256").update(JSON.stringify([identity, [...membership.nativeTurns].sort()])).digest("hex");
    const previous = matchingWakeResponseCheckpoint(row.scan, generationId, identity, binding, missingReceipt, membership.nativeTurns.keys());
    const bindingChanged = !!prior && prior.binding !== binding && !missingReceipt;
    const start = !bindingChanged && row.scanFrom?.generationId === generationId ? row.scanFrom.position : undefined;
    let fromPreparation = bindingChanged ? false : previous?.fromPreparation ?? (start !== undefined);
    let reduction = previous ? { ...previous.reduction } : emptyReduction();
    let answered = false;
    const visit = (event: Record<string, unknown>) => answered = reduceResponse(row, membership, reduction, event);
    try {
      signal?.throwIfAborted();
      const readBudgeted = async (position: RuntimeEventPosition | undefined) => {
        let page = await readRuntimeEventPage(generationId, position, visit, signal);
        const baseOffset = position ? position.offset + (position.skip ?? 0) + Buffer.byteLength(position.pending ?? "", "base64") : 0;
        let bytesRead = page ? Math.max(0, page.position.offset + (page.position.skip ?? 0)
          + Buffer.byteLength(page.position.pending ?? "", "base64") - baseOffset) : 0;
        while (page?.state === "more" && !answered && bytesRead < RESPONSE_REPLAY_TICK_BYTES) {
          const next = await readRuntimeEventPage(generationId, page.position, visit, signal);
          if (!next) return null;
          const before = page.position.offset + (page.position.skip ?? 0) + Buffer.byteLength(page.position.pending ?? "", "base64");
          const after = next.position.offset + (next.position.skip ?? 0) + Buffer.byteLength(next.position.pending ?? "", "base64");
          bytesRead += Math.max(0, after - before);
          page = next;
        }
        return page;
      };
      let page = await readBudgeted(previous?.position ?? start);
      // An idempotent send can return an older receipt. If the pre-admission
      // suffix has no witness, search the earlier prefix as for a legacy row.
      if (!page || (fromPreparation && page.state === "current" && !reduction.turnId)) {
        fromPreparation = false;
        reduction = emptyReduction();
        page = await readBudgeted(undefined);
      }
      if (!page) throw new Error("response ledger position is unavailable");
      scan.push({ generationId, identity, binding: missingReceipt && previous ? previous.binding : binding,
        nativeTurns: [...membership.nativeTurns],
        position: page.position, fromPreparation, reduction });
      if (page.state !== "current" && !answered && !reduction.terminal) wait = page.state === "more"
        ? "Delivered wake response evidence is still being checked in the host event log."
        : "Delivered wake response evidence is incomplete in the host event log.";
    } catch {
      signal?.throwIfAborted();
      wait = "Delivered wake response evidence is unreadable in the host event log.";
      if (prior) scan.push(prior);
      continue;
    }
    const evidence = responseEvidence(row, reduction, answered);
    if (!evidence.turnId) continue;
    const progress = turnSilenceProgress(conversation.engine, generationId, evidence.turnId);
    const observed = { ...evidence, generationId,
      ...(progress !== undefined && progress >= Date.parse(row.deliveredAt) && progress > Date.parse(evidence.progressAt ?? row.progressAt)
        ? { progressAt: new Date(progress).toISOString() } : {}) };
    if (observed.answered) return observed;
    // A failed successor cannot hide fulfillment in an older bound generation.
    latest ??= observed;
  }
  if (wait) return { answered: false, wait, scan };
  return latest ? { ...latest, scan } : { answered: false, wait: "Delivered input membership or generation evidence is unavailable.", scan };
}

interface ResponseMembership {
  operations: Map<string, boolean>;
  nativeTurns: Map<string, boolean>;
  receiptUnavailable: boolean;
}

function emptyReduction(): ResponseReduction {
  return { terminal: false, continuation: false, replied: false, providerFailure: false, inputBound: false };
}

function reduceResponse(row: SeatWakeResponse, membership: ResponseMembership, state: ResponseReduction, event: Record<string, unknown>): boolean {
  const turnId = event.turnId;
  if (typeof turnId !== "string") return false;
  const native = membership.nativeTurns.get(turnId);
  const operationStart = event.kind === "turn-started" ? membership.operations.get(turnId) : undefined;
  const start = operationStart ?? (event.kind === "turn-started" ? native : undefined);
  const echo = object(event.deliveryEcho);
  let linked = false;
  let continued = false;
  if (event.deliveryEcho) {
    for (const id of [echo.operationId, ...(Array.isArray(echo.memberOperationIds) ? echo.memberOperationIds : [])]) {
      const member = typeof id === "string" ? membership.operations.get(id) : undefined;
      linked ||= member !== undefined;
      continued ||= member === true;
    }
  }
  if (start !== undefined || turnId !== state.turnId && (linked || native !== undefined)) {
    Object.assign(state, emptyReduction(), { turnId, progressAt: undefined, continuation: start ?? native ?? false,
      inputBound: operationStart !== undefined });
  }
  if (turnId !== state.turnId) return false;
  if (linked && !state.inputBound) {
    // A receipt can identify an already-running native turn before the input
    // joins it. Output before the echo belongs to the earlier turn activity.
    state.replied = false;
    state.providerFailure = false;
    state.progressAt = undefined;
    state.inputBound = true;
  }
  state.continuation ||= continued;
  if (event.kind === "item") {
    const item = object(event.item);
    const message = object(item.message);
    const providerFailure = item.type === "assistant" && (item.error != null || item.isApiErrorMessage === true);
    if (providerFailure) { state.providerFailure = true; return false; }
    const type = item.sessionUpdate ?? item.type;
    const blocks = Array.isArray(message.content) ? message.content.map(object) : [];
    const actual = meaningfulModelProgress(item)
      || ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "webSearch", "imageView", "imageGeneration", "tool_call", "tool_call_update"].includes(String(type))
        && typeof (item.toolCallId ?? item.id) === "string" && !!(item.toolCallId ?? item.id)
      || blocks.some(block => block.type === "tool_use" && typeof block.id === "string" && !!block.id
        || block.type === "tool_result" && typeof block.tool_use_id === "string" && !!block.tool_use_id);
    if (actual) {
      const at = event.accountingAt ?? event.activityAt;
      if (typeof at === "string" && Number.isFinite(Date.parse(at)) && Date.parse(at) >= Date.parse(row.deliveredAt)) state.progressAt = at;
    }
    const response = type === "assistant" && blocks.some(block => block.type === "text" && typeof block.text === "string" && !!block.text.trim())
      || ["agentMessage", "agent_message_chunk"].includes(String(type))
        && [item.text, object(item.content).text].some(text => typeof text === "string" && !!text.trim());
    if (response) { state.replied = true; state.providerFailure = false; }
  }
  if (event.kind === "delta" && typeof event.text === "string" && event.text.trim()) { state.replied = true; state.providerFailure = false; }
  if (event.kind === "turn-ended") {
    state.terminal = ["completed", "error", "interrupted"].includes(String(event.status));
    return event.status === "completed" && state.replied && !state.providerFailure;
  }
  return false;
}

function responseEvidence(row: SeatWakeResponse, state: ResponseReduction, answered: boolean): WakeResponseEvidence {
  const { turnId, progressAt } = state;
  return { answered, terminal: state.terminal && (row.action !== "nudged" || state.continuation),
    ...(turnId ? { turnId } : {}), ...(progressAt ? { progressAt } : {}),
    ...(state.providerFailure && !answered ? { wait: "provider failure; original request awaits provider recovery", providerFailure: true } : {}),
    ...(!turnId ? { wait: "Delivered input membership or generation evidence is unavailable." } : {}) };
}

export function wakeResponseEvidenceFromEvents(row: SeatWakeResponse, events: Record<string, unknown>[], continuations: readonly string[] = [], nativeTurnId?: string, nativeContinuation = false, recoveryOperations: readonly string[] = continuations): WakeResponseEvidence {
  const turn = nativeTurnId ?? row.turnId;
  const membership: ResponseMembership = {
    operations: new Map([row.operationId, ...continuations].map(id => [id, id !== row.operationId && recoveryOperations.includes(id)])),
    nativeTurns: new Map(turn ? [[turn, nativeContinuation]] : []),
    receiptUnavailable: false,
  };
  const state = { ...emptyReduction(), ...(turn ? { turnId: turn, continuation: nativeContinuation } : {}) };
  let answered = false;
  for (const event of events) answered = reduceResponse(row, membership, state, event) || answered;
  return responseEvidence(row, state, answered);
}
