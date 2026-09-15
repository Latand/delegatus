"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { setVoiceConnected, setVoiceSpeaking } from "@/lib/audio/app";
import type { Speaker } from "@/lib/audio/ambientLoop";
import { speakingFromLines } from "@/lib/audio/speech";
import { codexRealtimeClient, type CodexRealtimeLine, type CodexRealtimeSnapshot } from "@/lib/realtime/codexRealtimeClient";
import { normalizeVoiceDeliveries, type RuntimeVoiceDelivery } from "@/lib/runtime/voiceDelivery";
import type { HostAxis, RuntimeVoiceTranscriptSegment } from "@/lib/runtime/contracts";

const EMPTY_ACKS: readonly string[] = [];

const IDLE = {
  phase: "idle" as const, lines: [], error: null, startedAt: null,
  micMuted: false, outputMuted: false, notice: null, agentUnavailable: null,
};

/**
 * The part of the realtime client this hook consumes.
 *
 * Named so the store can be swapped for one with no WebRTC under it, which is
 * the only way to drive the transcript-fed behaviours below — ducking above all
 * — through the REAL hook rather than a copy of it in a test.
 */
export interface RealtimeSurface {
  subscribe(listener: () => void): () => void;
  getSnapshot(): CodexRealtimeSnapshot;
  micStream(): MediaStream | null;
  toggleMic(): void;
  toggleOutput(): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  updateWorkerProgress(turnId: string, progress: string, running: boolean): void;
  reconcileWorkerDeliveries(
    deliveries: readonly RuntimeVoiceDelivery[],
    options?: { authoritative?: boolean; ready?: boolean },
  ): void;
  /** #1629: the app-server's own transcript, merged into the panel beside what
      the data channel delivered. */
  reconcileCanonicalTranscript(segments: readonly RuntimeVoiceTranscriptSegment[]): void;
  /** #1629: what the runtime says about the host behind this call, so a panel
      never claims a working agent link the runtime has already contradicted. */
  reportBackingHost(host: VoiceBackingHost): void;
  /** #691 §6: this call's credential, presented on every write into it and on every
      read of the inbox that carries its deploy nonces. */
  realtimeSession(): string | null;
  /* #691 §4: fires when the runtime host has DURABLY accepted a delivery, which is
     the only signal that may advance the bridge's cursor. */
  onDeliveryAcknowledged(listener: (deliveryId: string) => void): () => void;
}

/**
 * What the runtime says about the host behind a call (#1629).
 *
 * The runtime's own host axis, plus `unknown` for the window before any
 * projection has arrived. `registering`, `recovering` and `conflict` are all
 * states in which a call cannot be shown to reach an agent, so they are carried
 * through as themselves rather than folded into "fine".
 */
export type VoiceBackingHost = HostAxis | "unknown";

const NO_LINES: ReadonlySet<string> = new Set();

let clientFactory: (conversationId: string) => RealtimeSurface = codexRealtimeClient;

/** Test seam: `null` restores the real client. */
export function configureRealtimeClientForTests(factory: ((conversationId: string) => RealtimeSurface) | null): void {
  clientFactory = factory ?? codexRealtimeClient;
}

/**
 * One mounted realtime surface's lease on the background music: whether a call
 * is up, and who is talking in it.
 *
 * Both are per MOUNT, not per conversation, because several conversation cards
 * can have composers mounted at once. A mount speaks only for itself: it
 * releases only its own lease and clears only its own duck, so the card the
 * operator is not looking at can neither end the call nor let the music back up
 * over the voice in the one they are.
 *
 * Card switching is the case that decides the shape here. The focused card is a
 * keyed element, so React destroys the outgoing card's effects before creating
 * the incoming one's — the lease count legitimately passes through zero inside
 * one commit. `setVoiceConnected` settles that at the end of the tick rather
 * than acting on the instant, which is what keeps a swipe from restarting the
 * music.
 *
 * What the music then DOES with the signals is the audio module's business: with
 * music enabled on both sides of the call boundary this hook's edges change
 * nothing audible at all.
 */
/**
 * Who is talking IN THIS CALL, read from the transcript.
 *
 * The transcript outlives the call that produced it, on purpose: the operator
 * keeps reading it after a hangup. Nothing marks its last line final when a call
 * ends, either — a call that drops mid-sentence leaves a streaming line behind
 * for good. Read naively, that line says "the agent is talking" forever, and the
 * NEXT call would open already ducked with nobody saying anything.
 *
 * So every line the call inherited is disqualified at the moment it goes live.
 * The client numbers each line from a counter that only ever goes up and clears
 * its open-line table on teardown, so a new call cannot write into an inherited
 * id — which makes "was it already there?" an exact test for "is it from a call
 * that is over?", with no clock and no heuristic.
 *
 * The carried-over set is adjusted DURING the render that first sees the call
 * (React's documented way to derive state from a change), so the very first
 * committed render of a live call is already un-ducked. An effect would be a
 * commit late, and that commit is precisely the one that opens the duck.
 */
function useCurrentCallSpeaker(live: boolean, lines: readonly CodexRealtimeLine[]): Speaker | null {
  const [wasLive, setWasLive] = useState(live);
  const [carriedOver, setCarriedOver] = useState<ReadonlySet<string>>(NO_LINES);
  if (wasLive !== live) {
    setWasLive(live);
    setCarriedOver(live ? new Set(lines.map((line) => line.id)) : NO_LINES);
  }
  return useMemo(
    () => (live ? speakingFromLines(lines.filter((line) => !carriedOver.has(line.id))) : null),
    [carriedOver, lines, live],
  );
}

export function useAmbientCallLease(live: boolean, speaking: Speaker | null = null): void {
  const owner = useRef(Symbol("realtime-ambient-owner"));
  useEffect(() => {
    const held = owner.current;
    setVoiceConnected(held, live);
    return () => setVoiceConnected(held, false);
  }, [live]);
  useEffect(() => {
    const held = owner.current;
    /* Nobody is talking in a call that is not up — a call dropping mid-sentence
       leaves a non-final line behind for good, and the music must not stay held
       down under a voice that is gone. */
    setVoiceSpeaking(held, live ? speaking : null);
    return () => setVoiceSpeaking(held, null);
  }, [live, speaking]);
}

/**
 * The call's whole claim on the ambient bed — the lease plus the speaker read off
 * the transcript. Mounted by `VoicePipHost`, the Viewer-level owner of the call's
 * presentation, and nowhere else: a card-scoped lease died with its card on board
 * navigation and let the music back up mid-call.
 */
export function useCallAmbience(live: boolean, lines: readonly CodexRealtimeLine[]): void {
  useAmbientCallLease(live, useCurrentCallSpeaker(live, lines));
}

export function useCodexRealtime(
  conversationId: string,
  enabled: boolean,
  workerTurnId: string,
  workerProgress: string,
  workerRunning: boolean,
  workerDeliveries: readonly RuntimeVoiceDelivery[],
  /* #1629: the canonical transcript the runtime carried over from the
     app-server. Passed in like the deliveries above, from the same session
     projection, so the client stays the one place that decides what a line is. */
  canonicalTranscript: readonly RuntimeVoiceTranscriptSegment[] = [],
  /* #1629: the runtime's own verdict on the host behind the call. `unknown`
     while no projection has arrived, which asserts nothing either way. */
  backingHost: VoiceBackingHost = "unknown",
  deferredVoiceRevision?: number,
  acknowledgedVoiceIds: readonly string[] = EMPTY_ACKS,
) {
  const client = useMemo(
    () => enabled && conversationId.startsWith("conversation_") ? clientFactory(conversationId) : null,
    [conversationId, enabled],
  );
  const snapshot = useSyncExternalStore(
    client?.subscribe ?? (() => () => undefined),
    client?.getSnapshot ?? (() => IDLE),
    () => IDLE,
  );
  useEffect(() => {
    if (!client || !workerTurnId || !workerProgress) return;
    client.updateWorkerProgress(workerTurnId, workerProgress, workerRunning);
  }, [client, snapshot.phase, workerProgress, workerRunning, workerTurnId]);
  const [preparingVoice, setPreparingVoice] = useState<string | null>(null);
  const startEpoch = useRef(0);
  const startPending = useRef(false);
  const bodyKey = `${conversationId}:${deferredVoiceRevision ?? "full"}`;
  const [bodyState, setBodyState] = useState<{ key: string; deliveries: RuntimeVoiceDelivery[]; acknowledged: string[] } | null>(null);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const requestRef = useRef<{ key: string; promise: Promise<RuntimeVoiceDelivery[]> } | null>(null);
  const currentKey = useRef(bodyKey);
  currentKey.current = bodyKey;
  useEffect(() => () => { startEpoch.current += 1; startPending.current = false; }, [client, bodyKey]);
  const bodiesReady = deferredVoiceRevision === undefined || bodyState?.key === bodyKey;
  const mergedDeliveries = useMemo(() => {
    const acknowledged = new Set([...acknowledgedVoiceIds, ...(bodyState?.key === bodyKey ? bodyState.acknowledged : [])]);
    // The summary retains every pending delivery/response id. Streamed
    // acknowledgments remove those ids, so a hydrated body can never revive
    // work after the bounded tombstone tail has rolled over.
    const recovered = new Map((bodyState?.key === bodyKey ? bodyState.deliveries : []).map(delivery => [delivery.deliveryId, delivery]));
    return workerDeliveries.filter(delivery => !acknowledged.has(delivery.deliveryId)).map(delivery => {
      const body = recovered.get(delivery.deliveryId);
      if (!body) return delivery;
      const responses = new Map(body.responses.map(response => [response.responseId, response]));
      return { ...delivery, responses: delivery.responses.map(response => response.text ? response : responses.get(response.responseId) ?? response) };
    });
  }, [bodyKey, bodyState, workerDeliveries, acknowledgedVoiceIds]);
  const hydrateBodies = () => {
    if (deferredVoiceRevision === undefined) return Promise.resolve([...workerDeliveries]);
    if (bodyState?.key === bodyKey) return Promise.resolve(bodyState.deliveries);
    if (requestRef.current?.key === bodyKey) return requestRef.current.promise;
    const promise = (async () => {
      const response = await fetch(`/api/runtime/snapshot?voiceFor=${encodeURIComponent(conversationId)}`);
      if (!response.ok) throw new Error("Voice delivery recovery is unavailable");
      const value = await response.json() as { sessions?: Array<{ conversationId: string; revision: number; voiceDeliveries?: RuntimeVoiceDelivery[]; voiceDeliverySnapshotRevision?: number; acknowledgedVoiceDeliveryIds?: string[] }> };
      const session = value.sessions?.find(session => session.conversationId === conversationId);
      if (!session || session.voiceDeliverySnapshotRevision !== undefined || session.revision < deferredVoiceRevision)
        throw new Error("Voice delivery recovery is incomplete");
      const acknowledged = new Set(session.acknowledgedVoiceDeliveryIds ?? []);
      const deliveries = normalizeVoiceDeliveries(session.voiceDeliveries).filter(delivery => !acknowledged.has(delivery.deliveryId));
      if (currentKey.current === bodyKey) {
        setBodyState({ key: bodyKey, deliveries, acknowledged: [...acknowledged] });
        setBodyError(null);
      }
      return deliveries;
    })();
    requestRef.current = { key: bodyKey, promise };
    void promise.catch(error => { if (currentKey.current === bodyKey) setBodyError(error instanceof Error ? error.message : "Voice delivery recovery failed"); })
      .finally(() => { if (requestRef.current?.promise === promise) requestRef.current = null; });
    return promise;
  };
  useEffect(() => {
    // An omitted body is unknown, never an authoritative empty queue. A
    // reconnect snapshot re-arms hydration even for an already active call.
    if (!bodiesReady) {
      client?.reconcileWorkerDeliveries([], { ready: false });
      if (snapshot.phase === "idle" || snapshot.phase === "error") return;
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let delay = 1000;
      const recover = () => { void hydrateBodies().catch(() => {
        if (cancelled) return;
        timer = setTimeout(recover, delay);
        delay = Math.min(30_000, delay * 2);
      }); };
      recover();
      return () => { cancelled = true; if (timer) clearTimeout(timer); };
    }
    client?.reconcileWorkerDeliveries(mergedDeliveries, { authoritative: true, ready: true });
    // hydrateBodies joins one request per snapshot identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, snapshot.phase, bodyKey, bodiesReady, mergedDeliveries]);
  useEffect(() => {
    client?.reconcileCanonicalTranscript(canonicalTranscript);
  }, [canonicalTranscript, client]);
  useEffect(() => {
    client?.reportBackingHost(backingHost);
  }, [backingHost, client, snapshot.phase]);

  /* The ambient lease deliberately does NOT live here any more: this hook is
     card-scoped and the card unmounts mid-call on board navigation. The music's
     lease and duck belong to `VoicePipHost` via `useCallAmbience`. */

  return {
    ...snapshot,
    phase: preparingVoice === bodyKey && startPending.current ? "connecting" as const : snapshot.phase,
    error: snapshot.error ?? bodyError,
    /* Read at render time rather than stored: the stream appears with the
       `live` phase, which already re-renders this subtree. */
    micStream: client?.micStream() ?? null,
    toggleMic: () => client?.toggleMic(),
    toggleOutput: () => client?.toggleOutput(),
    realtimeSession: () => client?.realtimeSession() ?? null,
    start: async () => {
      if (!client || startPending.current || snapshot.phase === "connecting" || snapshot.phase === "live") return;
      const key = bodyKey;
      const epoch = ++startEpoch.current;
      startPending.current = true;
      setPreparingVoice(bodyKey);
      try {
        const deliveries = await hydrateBodies();
        if (currentKey.current !== key || startEpoch.current !== epoch) return;
        // A call starts only after its pending canonical outputs are known.
        const acknowledged = new Set(acknowledgedVoiceIds);
        client.reconcileWorkerDeliveries(deliveries.filter(delivery => !acknowledged.has(delivery.deliveryId)), { authoritative: true, ready: true });
        await client.start();
      } finally {
        if (startEpoch.current === epoch) { startPending.current = false; setPreparingVoice(null); }
      }
    },
    stop: () => {
      startEpoch.current += 1;
      startPending.current = false;
      setPreparingVoice(null);
      return client?.stop() ?? Promise.resolve();
    },
  };
}
