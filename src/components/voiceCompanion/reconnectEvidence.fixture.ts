import { OfficialVoiceCompanionAdapter } from "@/lib/voiceCompanion/liveAdapter";
import type { CompanionEvent, Payload } from "@/lib/voiceCompanion/contract";
import type { MediaCallbacks } from "@/lib/voiceCompanion/media";

/** Shared browser-driver seam: the real adapter/store against synthetic media and session answers. */
export function reconnectEvidence(locale: "en" | "uk") {
  let callbacks: MediaCallbacks;
  let starts = 0, opens = 0, muted = false, failing = false;
  let release: (() => void) | null = null;
  const sounds: string[] = [];
  const sessions: Array<{ id: string; request: string; events: CompanionEvent[]; closed: string | null }> = [];
  const event = (part: typeof sessions[number], payload: Payload) => part.events.push({ ...payload, version: 1, sessionId: part.id, generation: 1,
    seq: part.events.length + 1, eventId: `${part.id}-${part.events.length + 1}`, atMs: 0 } as CompanionEvent);
  const adapter = new OfficialVoiceCompanionAdapter({
    media: cb => {
      callbacks = cb;
      return { open: async () => { opens++; return "offer"; }, restart: async cb => { callbacks = cb; return "offer"; },
        answer: async () => {}, mute: value => { muted = value; }, interrupt() {}, close: async () => {} };
    },
    cues: { prepare() {}, connect() { sounds.push("connect"); }, disconnect() { sounds.push("disconnect"); }, timer() {},
      tick() { sounds.push("tick"); }, giveUp() { sounds.push("give-up"); }, dispose() {} },
    fetch: (async (input, init) => {
      const url = new URL(String(input), location.origin);
      if (url.pathname.endsWith("/resume")) {
        /* As the Viewer does (callResume's DROP_REASONS): a part the operator ended is never offered back. */
        const last = sessions.at(-1); return Response.json({ resumable: last?.closed === "transport" || last?.closed === "error" ? { sessionId: last.id, project: "atlas" } : null });
      }
      if (url.pathname.endsWith("/calls")) return Response.json({ calls: [] });
      if (!init?.body) {
        const part = sessions.find(row => row.id === url.searchParams.get("sessionId"));
        return Response.json({ events: part?.events.filter(row => row.seq > Number(url.searchParams.get("after") ?? 0)) ?? [] });
      }
      const body = JSON.parse(String(init.body));
      if (body.action === "start") {
        starts++;
        /* A plain answer settles in microtasks, so the attempt has failed by the time the frozen clock stops. */
        if (failing) return { ok: false, status: 503, json: async () => ({ code: "PROVIDER_ERROR" }) } as Response;
        const part = { id: `part-${starts}`, request: body.requestId as string, events: [] as CompanionEvent[], closed: null as string | null }; sessions.push(part);
        event(part, { type: "session.ready", mode: "official-realtime" });
        event(part, { type: "transcript.snapshot", speaker: "companion", itemId: "reply", final: true,
          text: locale === "uk" ? "Перевірка завершилася успішно. Розповідаю про наступний крок." : "The check passed. I am explaining the next step." });
        if (body.resume) await new Promise<void>(resolve => { release = resolve; });
        return Response.json({ sessionId: part.id, sdp: "answer" });
      }
      if (body.action === "close") {
        const part = sessions.find(row => row.id === body.sessionId || row.request === body.requestId);
        if (part && !part.closed) { part.closed = body.reason ?? "operator"; event(part, { type: "session.closed", reason: body.reason ?? "operator" }); }
      }
      return Response.json({ ok: true });
    }) as typeof fetch,
  });
  return { adapter, controls: {
    drop() { callbacks.playback({ rms: 0.4, speaking: true, playedMs: 500 }); callbacks.lost("PROVIDER_ERROR", "ice-failed"); },
    release() { release?.(); release = null; }, fail() { failing = true; }, recover() { failing = false; },
    read() { return { starts, opens, muted, sounds: [...sounds] }; },
  } };
}
