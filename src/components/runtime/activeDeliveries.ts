import type { RuntimeReceipt, RuntimeStore, RuntimeWrites } from "./runtimeModel";

const activeStates = new Set(["pending", "delivering", "applying", "queued", "uncertain"]);
function deliveryOwner(receipt?: RuntimeReceipt) {
  return receipt && (receipt.kind === "send" || receipt.kind === "steer" || receipt.kind === "inject")
    && activeStates.has(receipt.status) ? receipt.conversationId : undefined;
}
function running(store: RuntimeStore, id: string) {
  const turn = store.sessions[id]?.turn;
  return turn === "running" || turn === "interrupt_requested";
}

interface ActiveDeliveries {
  operations: Map<string, number>;
  conversations: Set<string>;
}
const byStore = new WeakMap<RuntimeStore, ActiveDeliveries>();

export function activeDeliveryConversations(store: RuntimeStore): ReadonlySet<string> {
  const existing = byStore.get(store);
  if (existing) return existing.conversations;
  const operations = new Map<string, number>();
  for (const receipt of Object.values(store.operations)) {
    const id = deliveryOwner(receipt);
    if (id !== undefined) operations.set(id, (operations.get(id) ?? 0) + 1);
  }
  const conversations = new Set(operations.keys());
  for (const id of Object.keys(store.sessions)) if (running(store, id)) conversations.add(id);
  byStore.set(store, { operations, conversations });
  return conversations;
}

/** Carry an admitted index across one immutable write. A conversation stays active while
 * any delivery or the current turn still needs its row. Retained snapshots keep their own index. */
export function carryActiveDeliveries(before: RuntimeStore, after: RuntimeStore, writes: RuntimeWrites): string[] {
  const previous = byStore.get(before);
  if (!previous) return [];
  let { operations, conversations } = previous;
  const oldOwner = writes.operationId === undefined ? undefined : deliveryOwner(before.operations[writes.operationId]);
  const newOwner = writes.operationId === undefined ? undefined : deliveryOwner(after.operations[writes.operationId]);
  if (oldOwner === newOwner && (writes.conversationId === undefined
    || running(before, writes.conversationId) === running(after, writes.conversationId))) {
    byStore.set(after, previous);
    return [];
  }
  if (oldOwner !== newOwner) {
    operations = new Map(operations);
    if (oldOwner !== undefined) {
      const remaining = (operations.get(oldOwner) ?? 1) - 1;
      if (remaining) operations.set(oldOwner, remaining);
      else operations.delete(oldOwner);
    }
    if (newOwner !== undefined) operations.set(newOwner, (operations.get(newOwner) ?? 0) + 1);
  }
  const changed: string[] = [];
  for (const id of new Set([writes.conversationId, oldOwner, newOwner])) {
    if (id === undefined) continue;
    const active = operations.has(id) || running(after, id);
    if (conversations.has(id) === active) continue;
    if (conversations === previous.conversations) conversations = new Set(conversations);
    if (active) conversations.add(id);
    else conversations.delete(id);
    changed.push(id);
  }
  byStore.set(after, operations === previous.operations && conversations === previous.conversations
    ? previous : { operations, conversations });
  return changed;
}
