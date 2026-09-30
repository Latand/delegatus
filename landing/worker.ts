export interface DataPoint {
  blobs: string[];
  doubles: number[];
  indexes: string[];
}

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  SITE_EVENTS: { writeDataPoint(point: DataPoint): void };
}

type SiteEvent = {
  event: "copy_prompt" | "copy_legacy" | "demo_start" | "fullscreen_open";
  lang: "en" | "uk";
  agent?: "claude" | "codex";
};

function isSiteEvent(value: unknown): value is SiteEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (body.lang !== "en" && body.lang !== "uk") return false;
  if (body.event === "copy_prompt") {
    return (body.agent === "claude" || body.agent === "codex") &&
      Object.keys(body).length === 3;
  }
  return ["copy_legacy", "demo_start", "fullscreen_open"].includes(body.event as string) &&
    Object.keys(body).length === 2;
}

// Bound even a chunked body before parsing it; events are under 100 bytes.
async function readEvent(request: Request): Promise<unknown> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

const reply = (status: number, text?: string, headers?: HeadersInit) =>
  new Response(text, { status, headers: { "Cache-Control": "no-store", ...headers } });

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (pathname !== "/api/event") return reply(404, "Not found");
    if (request.method !== "POST") return reply(405, "Method not allowed", { Allow: "POST" });

    let body: unknown;
    try {
      body = await readEvent(request);
    } catch {
      return reply(400, "Invalid event");
    }
    if (!isSiteEvent(body)) return reply(400, "Invalid event");

    // Only Cloudflare's country is used. No headers, IP, cookie or identifier.
    const cf = (request as Request & { cf?: { country?: unknown } }).cf;
    const country = typeof cf?.country === "string" && /^[A-Z]{2}$/.test(cf.country) ? cf.country : "";
    env.SITE_EVENTS.writeDataPoint({
      blobs: [body.event, body.agent ?? "", body.lang, country],
      doubles: [1],
      indexes: [body.event],
    });
    return reply(204);
  },
};

export default worker;
