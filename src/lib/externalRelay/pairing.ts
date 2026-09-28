import { randomUUID } from "node:crypto";
import { forgetRelayActivity } from "./activity";
import { discoverRelay, ExternalRelayError, relayCall } from "./client";
import {
  pairingConfirmedSchema,
  pairingStartedSchema,
  pairingStatusSchema,
} from "./protocol";
import {
  publicPending,
  readRelayStore,
  updateRelayStore,
  type PairedRelay,
  type PendingRelay,
} from "./store";

export async function startRelayPairing(url: string, label?: string) {
  const { origin, descriptor } = await discoverRelay(url);
  const store = readRelayStore();
  const result = await relayCall(descriptor.api_base, "/pairings", "POST", {
    install: { id: store.installId, label: label || store.label },
    versions: [1],
  });
  const started = pairingStartedSchema.parse(result.body);
  const pending: PendingRelay = {
    id: randomUUID(),
    origin,
    api_base: descriptor.api_base,
    name: descriptor.name,
    description: descriptor.description,
    limits: descriptor.limits,
    ...started,
  };
  updateRelayStore((current) => ({
    ...current,
    pending: [
      ...current.pending.filter((item) => item.origin !== origin),
      pending,
    ],
  }));
  return publicPending(pending);
}
function pendingById(id: string): PendingRelay {
  const pending = readRelayStore().pending.find((item) => item.id === id);
  if (!pending) throw new ExternalRelayError("not_found", 404);
  return pending;
}
export async function checkRelayPairing(id: string) {
  const pending = pendingById(id);
  const result = await relayCall(
    pending.api_base,
    `/pairings/${encodeURIComponent(pending.pairing_id)}`,
    "GET",
    undefined,
    pending.poll_secret,
  );
  const status = pairingStatusSchema.parse(result.body);
  if (status.status === "awaiting_install")
    updateRelayStore((store) => ({
      ...store,
      pending: store.pending.map((item) =>
        item.id === id
          ? { ...item, owner: status.owner, targets: status.targets }
          : item,
      ),
    }));
  // A pairing the service ended cannot be resumed, so its entry and poll
  // secret go now; the returned status still tells the UI why it ended.
  else if (status.status !== "pending")
    updateRelayStore((store) => ({
      ...store,
      pending: store.pending.filter((item) => item.id !== id),
    }));
  return status;
}
export async function confirmRelayPairing(
  id: string,
  ownerId: string,
): Promise<Omit<PairedRelay, "credential">> {
  const pending = pendingById(id);
  if (!pending.owner || pending.owner.id !== ownerId)
    throw new ExternalRelayError("owner_changed", 409);
  const result = await relayCall(
    pending.api_base,
    `/pairings/${encodeURIComponent(pending.pairing_id)}/confirm`,
    "POST",
    { owner_id: ownerId },
    pending.poll_secret,
  );
  const confirmed = pairingConfirmedSchema.parse(result.body);
  if (
    confirmed.version !== 1 ||
    confirmed.owner.id !== ownerId ||
    confirmed.owner.namespace !== pending.owner.namespace
  )
    throw new ExternalRelayError("owner_changed", 409);
  const relay: PairedRelay = {
    id: pending.id,
    origin: pending.origin,
    api_base: pending.api_base,
    name: pending.name,
    description: pending.description,
    credential: confirmed.credential,
    owner: confirmed.owner,
    pairedAt: new Date().toISOString(),
    paused: false,
    limits: pending.limits,
    targets: confirmed.targets.map((target) => ({
      id: target.target_id,
      name: target.name,
      answered_by: target.answered_by,
      fallback: target.fallback,
      enabled: true,
      engine: null,
      model: null,
      effort: null,
      project: null,
      concurrency: 1,
      hardCapMinutes: 30,
    })),
  };
  updateRelayStore((store) => ({
    ...store,
    relays: [...store.relays.filter((item) => item.id !== id), relay],
    pending: store.pending.filter((item) => item.id !== id),
  }));
  const { credential: _credential, ...publicRelay } = relay;
  return publicRelay;
}
export async function cancelRelayPairing(id: string): Promise<void> {
  const pending = pendingById(id);
  await relayCall(
    pending.api_base,
    `/pairings/${encodeURIComponent(pending.pairing_id)}`,
    "DELETE",
    undefined,
    pending.poll_secret,
  );
  updateRelayStore((store) => ({
    ...store,
    pending: store.pending.filter((item) => item.id !== id),
  }));
}
export async function unpairRelay(id: string): Promise<{ warned: boolean }> {
  const relay = readRelayStore().relays.find((item) => item.id === id);
  if (!relay) throw new ExternalRelayError("not_found", 404);
  let warned = false;
  try {
    await relayCall(
      relay.api_base,
      "/pairing",
      "DELETE",
      undefined,
      relay.credential,
    );
  } catch {
    warned = true;
  }
  updateRelayStore((store) => ({
    ...store,
    relays: store.relays.filter((item) => item.id !== id),
  }));
  forgetRelayActivity(id);
  return { warned };
}
