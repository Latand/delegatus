import type { SessionKey } from "@/lib/agent/sessionKey";

type Listener = (filename: string, key: SessionKey) => void;
const shared = globalThis as typeof globalThis & { __agentStateInvalidation?: Listener };
/** A hint carries no authority. The serving owner rereads the current entry. */
export function invalidateAgentState(filename: string, key: SessionKey): void {
  shared.__agentStateInvalidation?.(filename, key);
}
export function listenForAgentStateInvalidation(listener: Listener): () => void {
  shared.__agentStateInvalidation = listener;
  return () => { if (shared.__agentStateInvalidation === listener) delete shared.__agentStateInvalidation; };
}
