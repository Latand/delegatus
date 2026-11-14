import crypto from "node:crypto";
import { seatTickWorkSignal } from "./seatTickWork";
import { parseMessageOrigin, type MessageOrigin } from "@/lib/runtime/messageOrigin";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { agentRegistry } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { lookupOriginalSend } from "@/lib/runtime/sendSettlement";
import { runtimeHostClient } from "@/lib/runtime/client";
import { meaningfulModelProgress, turnSilenceProgress } from "@/lib/runtime/turnSilence";
import { readStableTailRecords } from "@/lib/scanner/activity";

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
    ? { ...row } : undefined;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

/** Read only the bounded event tail of the delivered input's generation. An
 * exact input/turn witness is required; a newer unrelated turn grants nothing. */
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
  const recoveryOperations = recoveryBindings.flatMap(binding => [binding.operationId, ...(binding.batchId ? [binding.batchId] : [])]);
  const bindings: Binding[] = [...recoveryBindings, original];
  // Keep previously proven native membership even after receipt compaction.
  if (row.generationId && row.turnId) bindings.push({ operationId: row.operationId, generationId: row.generationId, nativeTurnId: row.turnId });
  const generationFor = (binding: Binding) => binding.generationId
    ? conversation.generations.find(generation => generation.id === binding.generationId) : conversation.generations.at(-1);
  bindings.sort((left, right) => conversation.generations.indexOf(generationFor(right)!) - conversation.generations.indexOf(generationFor(left)!));
  const continuations = bindings.flatMap(binding => [binding.operationId, ...(binding.batchId ? [binding.batchId] : [])]);
  const client = runtimeHostClient();
  let latest: WakeResponseEvidence | undefined;
  for (const binding of bindings) {
    const generation = generationFor(binding);
    if (!generation) continue;
    let nativeTurnId = binding.operationId === original.operationId && row.generationId === generation.id && row.turnId
      ? row.turnId : binding.nativeTurnId;
    if (!nativeTurnId) try {
      const result = await client?.operationStatus(binding.operationId);
      if (result?.operationId === binding.operationId && result.receipt.conversationId === row.conversationId
        && ["delivered", "applied", "answered"].includes(result.receipt.status) && result.receipt.turnId) nativeTurnId = result.receipt.turnId;
    } catch { /* Native event membership remains independently readable. */ }
    // A fallback native turn belongs to the retained row, and cannot prove
    // that the separately admitted recovery reached its own native turn.
    const nativeContinuation = nativeTurnId !== undefined && recoveryBindings.includes(binding);
    nativeTurnId ??= row.generationId === generation.id ? row.turnId : undefined;
    const read = await readStableTailRecords(path.join(statePath("structured-host-events"), `${encodeURIComponent(generation.id)}.jsonl`));
    if (read.integrity !== "complete") continue;
    const evidence = wakeResponseEvidenceFromEvents({ ...row, turnId: nativeTurnId }, read.records, continuations, nativeTurnId, nativeContinuation, recoveryOperations);
    if (!evidence.turnId) continue;
    const progress = turnSilenceProgress(conversation.engine, generation.id, evidence.turnId);
    const observed = { ...evidence, generationId: generation.id,
      ...(progress !== undefined && progress >= Date.parse(row.deliveredAt) && progress > Date.parse(evidence.progressAt ?? row.progressAt)
        ? { progressAt: new Date(progress).toISOString() } : {}) };
    if (observed.answered) return observed;
    // A failed successor cannot hide fulfillment in an older bound generation.
    latest ??= observed;
  }
  return latest ?? { answered: false, wait: "delivered input membership or generation evidence unavailable" };
}

export function wakeResponseEvidenceFromEvents(row: SeatWakeResponse, events: Record<string, unknown>[], continuations: readonly string[] = [], nativeTurnId?: string, nativeContinuation = false, recoveryOperations: readonly string[] = continuations): WakeResponseEvidence {
  const ids = new Set([row.operationId, ...continuations]);
  let turn: string | null = nativeTurnId ?? row.turnId ?? null;
  let answered = false;
  let terminal = false;
  let continuation = nativeContinuation;
  let replied = false;
  let progressAt: string | undefined;
  let failure: string | undefined;
  for (const event of events) {
    if (event.kind === "turn-started" && ids.has(String(event.turnId))) {
      turn = String(event.turnId); replied = false; terminal = false; progressAt = undefined; failure = undefined;
      continuation = turn !== row.operationId && recoveryOperations.includes(turn);
    }
    const echo = object(event.deliveryEcho);
    if ((ids.has(String(echo.operationId)) || Array.isArray(echo.memberOperationIds) && echo.memberOperationIds.some(id => ids.has(String(id)))) && typeof event.turnId === "string") {
      if (turn !== event.turnId) {
        turn = event.turnId; replied = false; terminal = false; progressAt = undefined; failure = undefined; continuation = false;
      }
      continuation ||= recoveryOperations.some(id => id !== row.operationId && (echo.operationId === id
        || Array.isArray(echo.memberOperationIds) && echo.memberOperationIds.includes(id)));
    }
    if (!turn || event.turnId !== turn) continue;
    if (event.kind === "item") {
      const item = object(event.item);
      const message = object(item.message);
      const providerFailure = item.type === "assistant" && (item.error != null || item.isApiErrorMessage === true);
      if (providerFailure) { failure = "provider failure; original request awaits provider recovery"; continue; }
      const type = item.sessionUpdate ?? item.type;
      const blocks = Array.isArray(message.content) ? message.content.map(object) : [];
      const actual = meaningfulModelProgress(item)
        || ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "webSearch", "imageView", "imageGeneration", "tool_call", "tool_call_update"].includes(String(type))
          && typeof (item.toolCallId ?? item.id) === "string" && !!(item.toolCallId ?? item.id)
        || blocks.some(block => block.type === "tool_use" && typeof block.id === "string" && !!block.id
          || block.type === "tool_result" && typeof block.tool_use_id === "string" && !!block.tool_use_id);
      if (actual) {
        const at = event.accountingAt ?? event.activityAt;
        if (typeof at === "string" && Number.isFinite(Date.parse(at)) && Date.parse(at) >= Date.parse(row.deliveredAt)) progressAt = at;
      }
      const response = type === "assistant" && blocks.some(block => block.type === "text" && typeof block.text === "string" && !!block.text.trim())
        || ["agentMessage", "agent_message_chunk"].includes(String(type))
          && [item.text, object(item.content).text].some(text => typeof text === "string" && !!text.trim());
      if (response) { replied = true; failure = undefined; }
    }
    if (event.kind === "delta" && typeof event.text === "string" && event.text.trim()) { replied = true; failure = undefined; }
    if (event.kind === "turn-ended") {
      terminal = ["completed", "error", "interrupted"].includes(String(event.status));
      if (event.status === "completed" && replied && !failure) answered = true;
    }
  }
  return { answered, terminal: terminal && (row.action !== "nudged" || continuation), ...(turn ? { turnId: turn } : {}), ...(progressAt ? { progressAt } : {}), ...(failure && !answered ? { wait: failure, providerFailure: true } : {}), ...(!turn ? { wait: "delivered input membership is outside the verified event tail" } : {}) };
}
