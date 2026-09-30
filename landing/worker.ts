export interface DataPoint {
  blobs: string[];
  doubles: number[];
  indexes: string[];
}

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  INSTALLS: { writeDataPoint(point: DataPoint): void };
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

type InstallPing = { id: string; v: string; os: string; arch: string; kind: "packaged" | "checkout" | "docker" };
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
function isInstallPing(value: unknown): value is InstallPing {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const b = value as Record<string, unknown>;
  return Object.keys(b).length === 5 &&
    typeof b.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(b.id) &&
    typeof b.v === "string" && b.v.length <= 128 && semver.test(b.v) &&
    ["aix", "darwin", "freebsd", "linux", "openbsd", "sunos", "win32", "android", "haiku", "netbsd", "cygwin"].includes(b.os as string) &&
    ["arm", "arm64", "ia32", "loong64", "mips", "mipsel", "ppc", "ppc64", "riscv64", "s390", "s390x", "x64"].includes(b.arch as string) &&
    ["packaged", "checkout", "docker"].includes(b.kind as string);
}

// Bound even a chunked body before parsing it; events are under 100 bytes.
async function readBody(request: Request, limit = 1024): Promise<unknown> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
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
    if (pathname !== "/api/event" && pathname !== "/api/ping") return reply(404, "Not found");
    if (request.method !== "POST") return reply(405, "Method not allowed", { Allow: "POST" });

    let body: unknown;
    try {
      body = await readBody(request, pathname === "/api/ping" ? 512 : 1024);
    } catch {
      return reply(400, pathname === "/api/ping" ? "Invalid ping" : "Invalid event");
    }

    // Country comes only from Cloudflare metadata. Never inspect IP headers or cookies.
    const cf = (request as Request & { cf?: { country?: unknown } }).cf;
    const country = typeof cf?.country === "string" && /^[A-Z]{2}$/.test(cf.country) ? cf.country : "";
    if (pathname === "/api/ping") {
      if (!isInstallPing(body)) return reply(400, "Invalid ping");
      env.INSTALLS.writeDataPoint({ blobs: [body.id, body.v, body.os, body.arch, body.kind, country], doubles: [1], indexes: [body.id] });
      return reply(204);
    }
    if (!isSiteEvent(body)) return reply(400, "Invalid event");
    env.SITE_EVENTS.writeDataPoint({
      blobs: [body.event, body.agent ?? "", body.lang, country],
      doubles: [1],
      indexes: [body.event],
    });
    return reply(204);
  },
};

export default worker;
