import type { Locale } from "./contract";
import { liveSessionConfiguration, type BackendRequest } from "./sessionConfig";

export type LiveCommand = Record<string, unknown> & { type: string };
export interface LiveConnection { send(event: LiveCommand): void; dispose(): void }
export interface LiveProvider {
  create(key: string, locale: Locale, sdp: string): Promise<{ id: string; sdp: string }>;
  attach(id: string, key: string, event: (value: unknown) => void, lost: () => void): Promise<LiveConnection>;
  hangup(id: string, key: string): Promise<void>;
  /** One backend response, paid for by the caller before it is asked. */
  respond(key: string, request: BackendRequest, signal: AbortSignal): Promise<unknown>;
}
export const jsonObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Fixed official endpoints. Never logs upstream errors, configuration, SDP,
 * credentials or provider snapshots. No automatic paid mint retries. */
export class OpenAILiveProvider implements LiveProvider {
  constructor(private readonly http: typeof fetch = fetch,
    private readonly socket: (url: string, key: string) => WebSocket = (url, key) => {
      const AuthorizedWebSocket = WebSocket as unknown as { new(url: string, options: { headers: Record<string, string> }): WebSocket };
      return new AuthorizedWebSocket(url, { headers: { Authorization: `Bearer ${key}` } });
    }) {}
  async hangup(id: string, key: string): Promise<void> {
    try {
      const response = await this.http(`https://api.openai.com/v1/live/sessions/${encodeURIComponent(id)}/hangup`, { method: "POST", redirect: "error",
        headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
      // A session the provider no longer has is closed: nothing is left to hang up or to bill.
      if (!response.ok && response.status !== 404 && response.status !== 410) throw new Error("PROVIDER_ERROR");
    } catch { throw new Error("PROVIDER_ERROR"); }
  }
  async respond(key: string, request: BackendRequest, signal: AbortSignal): Promise<unknown> {
    try {
      const response = await this.http("https://api.openai.com/v1/responses", { method: "POST", redirect: "error",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(request),
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
      if (!response.ok) throw new Error("PROVIDER_ERROR");
      return await response.json();
    } catch { throw new Error("PROVIDER_ERROR"); }
  }
  async create(key: string, locale: Locale, sdp: string) {
    try {
      const response = await this.http("https://api.openai.com/v1/live/sessions", { method: "POST", redirect: "error",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ session: liveSessionConfiguration(locale), transport: { type: "webrtc", sdp } }),
        signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("PROVIDER_ERROR");
      const result = jsonObject(await response.json());
      const session = jsonObject(result?.session); const transport = jsonObject(result?.transport);
      if (typeof session?.id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(session.id)
        || transport?.type !== "webrtc" || typeof transport.sdp !== "string" || transport.sdp.length > 96_000) throw new Error("PROVIDER_ERROR");
      return { id: session.id, sdp: transport.sdp };
    } catch { throw new Error("PROVIDER_ERROR"); }
  }
  async attach(id: string, key: string, event: (value: unknown) => void, lost: () => void): Promise<LiveConnection> {
    const socket = this.socket(`wss://api.openai.com/v1/live/sessions/${encodeURIComponent(id)}/attach`, key);
    let disposed = false;
    socket.addEventListener("message", message => {
      if (disposed || typeof message.data !== "string" || message.data.length > 1_000_000) return;
      try { event(JSON.parse(message.data)); } catch { lost(); }
    });
    socket.addEventListener("close", () => { if (!disposed) lost(); });
    socket.addEventListener("error", () => { if (!disposed) lost(); });
    try { await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
      };
      const opened = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error("PROVIDER_ERROR")); };
      const timer = setTimeout(() => { disposed = true; socket.close(); failed(); }, 10_000);
      socket.addEventListener("open", opened);
      socket.addEventListener("error", failed);
      socket.addEventListener("close", failed);
    }); } catch { disposed = true; socket.close(); throw new Error("PROVIDER_ERROR"); }
    return { send: command => { if (socket.readyState !== WebSocket.OPEN) throw new Error("PROVIDER_ERROR"); socket.send(JSON.stringify(command)); },
      dispose: () => { disposed = true; socket.close(); } };
  }
}
