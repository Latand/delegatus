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
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let started = false, finished = false, bytes = 0;
    const finish = (error?: Error, cancelled = false) => {
      if (finished) return;
      finished = true;
      options.signal.removeEventListener("abort", abort);
      socket.close();
      if (error) { if (!started) reject(error); controller.error(error); }
      else if (!cancelled) controller.close();
    };
    const abort = () => finish(Error("speech cancelled"));
    const stream = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      cancel() { finish(undefined, true); },
    });
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
          controller.enqueue(audio);
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
