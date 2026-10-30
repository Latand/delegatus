import WebSocket from "ws";

export type SpeechSocketFactory = (url: string, key: string) => WebSocket;
const productionSocket: SpeechSocketFactory = (url, key) => new WebSocket(url, { headers: { Authorization: `Bearer ${key}` }, maxPayload: 2 * 1024 * 1024 });
let socketFactory = productionSocket;
/** Local protocol tests only; never changes the production endpoint. */
export function setSpeechSocketForTests(factory: SpeechSocketFactory | null): void { socketFactory = factory ?? productionSocket; }

/** Resolves on the first audio bytes, so pre-audio failures retain HTTP 502. */
export function openAiRealtimeSpeech(options: { apiKey: string; model: string; voice: string; text: string; signal: AbortSignal }): Promise<ReadableStream<Uint8Array>> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) { reject(Error("speech cancelled")); return; }
    const socket = socketFactory(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(options.model)}`, options.apiKey);
    let started = false, finished = false, cancelled = false, bytes = 0;
    let failure: Error | undefined;
    const chunks: Uint8Array[] = [];
    let wake: (() => void) | undefined;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true; failure = error;
      options.signal.removeEventListener("abort", abort);
      socket.close();
      if (error && !started) reject(error);
      wake?.();
    };
    const abort = () => finish(Error("speech cancelled"));
    // Deliver received bytes before a later failure. Lazy pulls also avoid an
    // already-errored stream being handed to Bun's Response body consumer.
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!chunks.length && !finished) await new Promise<void>(resolve => { wake = resolve; });
        wake = undefined;
        if (cancelled) return;
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else if (failure) controller.error(failure);
        else if (finished) controller.close();
      },
      cancel() { cancelled = true; chunks.length = 0; finish(); },
    }, { highWaterMark: 0 });
    options.signal.addEventListener("abort", abort, { once: true });
    socket.addEventListener("open", () => {
      if (finished) return;
      try {
        socket.send(JSON.stringify({ type: "session.update", session: { type: "realtime", instructions: "Read the user's text aloud without adding commentary.",
          output_modalities: ["audio"], audio: { output: { voice: options.voice, format: { type: "audio/pcm", rate: 24000 } } } } }));
        socket.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: options.text }] } }));
        socket.send(JSON.stringify({ type: "response.create", response: { output_modalities: ["audio"] } }));
      } catch { finish(Error("speech request failed")); }
    });
    socket.addEventListener("message", message => {
      if (finished) return;
      try {
        const event = JSON.parse(String(message.data));
        if (event.type === "error") { finish(Error("speech provider failed")); return; }
        if (event.type === "response.output_audio.delta") {
          if (typeof event.delta !== "string" || !event.delta.length || event.delta.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.delta)) throw Error("invalid audio");
          const audio = Buffer.from(event.delta, "base64");
          bytes += audio.length;
          if (bytes > 32 * 1024 * 1024) throw Error("audio too large");
          if (chunks.length >= 4096) throw Error("too many buffered chunks");
          chunks.push(audio); wake?.();
          if (!started) { started = true; resolve(stream); }
        } else if (event.type === "response.done") {
          finish(event.response?.status === "completed" && started ? undefined : Error("speech did not complete"));
        }
      } catch { finish(Error("speech protocol failed")); }
    });
    socket.addEventListener("error", () => finish(Error("speech connection failed")));
    socket.addEventListener("close", () => { if (!finished) finish(Error("speech connection closed")); });
    if (options.signal.aborted) abort();
  });
}
