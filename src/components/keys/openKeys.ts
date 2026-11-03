import type { KeyId } from "@/lib/keys/shared";

/*
 * «Open Keys on this key» (docs/design/keys-settings.md §4): the places that
 * asked for a key on their own (memory, the setup guide's voice step, the
 * voice companion dialog) open the header menu's «Keys» page on that key
 * instead. One window event; the menu that is on screen answers it. A menu
 * that is not mounted yet (the desktop rail put away, the phone sheet closed)
 * is opened by the Viewer and reads the request when it mounts.
 */

export const OPEN_KEYS_EVENT = "delegatus:open-keys";
/** A key changed in «Keys»: the event the memory page and the «Asks you» switch already re-read on. */
export const KEYS_CHANGED_EVENT = "delegatus:provider-key-changed";
/** A provider choice under «Keys» settled, kept or refused: the readers that name a feature's provider read again. */
export const SERVICE_SETTLED_EVENT = "delegatus:openai-service-settled";
export interface ServiceSettled { feature: string }

export function serviceSettled(feature: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ServiceSettled>(SERVICE_SETTLED_EVENT, { detail: { feature } }));
}

/** Calls `listener` each time a choice for `feature` settles. */
export function onServiceSettled(feature: string, listener: () => void): () => void {
  const handle = (event: Event) => { if ((event as CustomEvent<ServiceSettled>).detail?.feature === feature) listener(); };
  window.addEventListener(SERVICE_SETTLED_EVENT, handle);
  return () => window.removeEventListener(SERVICE_SETTLED_EVENT, handle);
}

export interface OpenKeysRequest { key: KeyId | null }

/* A request no menu took within this long is stale: it must not open a menu the operator opens later by hand. */
const PENDING_MS = 3_000;
let pending: { request: OpenKeysRequest; at: number } | null = null;

export function openKeys(key: KeyId | null = null): void {
  if (typeof window === "undefined") return;
  pending = { request: { key }, at: Date.now() };
  window.dispatchEvent(new CustomEvent<OpenKeysRequest>(OPEN_KEYS_EVENT, { detail: { key } }));
}

/** The request a menu mounting now should open on, without taking it. */
export function pendingKeys(): OpenKeysRequest | null {
  if (pending && Date.now() - pending.at > PENDING_MS) pending = null;
  return pending?.request ?? null;
}

/** The menu that opened the page took the request. */
export function settleKeys(): void {
  pending = null;
}

export function onOpenKeys(listener: (request: OpenKeysRequest) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<OpenKeysRequest>).detail ?? { key: null });
  window.addEventListener(OPEN_KEYS_EVENT, handle);
  return () => window.removeEventListener(OPEN_KEYS_EVENT, handle);
}
