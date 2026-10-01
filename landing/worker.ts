export interface DataPoint {
  blobs: string[];
  doubles: number[];
  indexes: string[];
}

export interface Env {
  STATS_ACCESS_TEAM_DOMAIN?: string;
  STATS_ACCESS_AUD?: string;
  STATS_ACCOUNT_ID?: string;
  STATS_AE_TOKEN?: string;
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
    if (pathname === "/stats" || pathname === "/stats/") return statsResponse(request, env);
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

// Public signing keys only. A single issuer cache bounds memory and refresh traffic.
type AccessKey = JsonWebKey & { kid?: string };
let accessKeys: { issuer: string; expires: number; keys: AccessKey[] } | undefined;
let keysPending: { issuer: string; promise: Promise<AccessKey[]> } | undefined;
async function signingKeys(issuer: string): Promise<AccessKey[]> {
  if (accessKeys?.issuer === issuer && accessKeys.expires > Date.now()) return accessKeys.keys;
  if (keysPending?.issuer === issuer) return keysPending.promise;
  const promise = (async () => {
    const response = await fetch(`${issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) throw new Error("Access keys unavailable");
    const body = await response.json() as { keys?: AccessKey[] };
    if (!Array.isArray(body.keys) || body.keys.length > 20) throw new Error("Invalid key set");
    accessKeys = { issuer, expires: Date.now() + 300_000, keys: body.keys };
    return body.keys;
  })();
  keysPending = { issuer, promise };
  try { return await promise; } finally { if (keysPending?.promise === promise) keysPending = undefined; }
}

function jwtBytes(part: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error("Invalid JWT encoding");
  const binary = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
async function validAccess(request: Request, env: Env): Promise<boolean> {
  try {
    const domain = env.STATS_ACCESS_TEAM_DOMAIN;
    if (!domain || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain) || !env.STATS_ACCESS_AUD) return false;
    const issuer = `https://${domain}`;
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token || token.length > 16_384) return false;
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const header = JSON.parse(new TextDecoder().decode(jwtBytes(parts[0]))) as { alg?: string; kid?: string };
    const claims = JSON.parse(new TextDecoder().decode(jwtBytes(parts[1]))) as { iss?: string; aud?: unknown; exp?: number; nbf?: number };
    const now = Date.now() / 1000;
    if (header.alg !== "RS256" || typeof header.kid !== "string" || claims.iss !== issuer ||
      typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= now ||
      (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > now)) ||
      !(claims.aud === env.STATS_ACCESS_AUD || (Array.isArray(claims.aud) && claims.aud.includes(env.STATS_ACCESS_AUD)))) return false;
    const jwk = (await signingKeys(issuer)).find(key => key.kid === header.kid && key.kty === "RSA" && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig"));
    if (!jwk) return false;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const verified = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, jwtBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    return verified && claims.exp > Date.now() / 1000;
  } catch {
    // Fail closed. Never log assertions, credentials, fetch URLs or upstream errors.
    return false;
  }
}

type Row = Record<string, string | number | null>;
type QueryResult = { rows: Row[]; failed: boolean };
async function statsQuery(env: Env, sql: string): Promise<QueryResult> {
  try {
    if (!env.STATS_ACCOUNT_ID || !/^[a-f0-9]{32}$/.test(env.STATS_ACCOUNT_ID) || !env.STATS_AE_TOKEN) throw new Error("Stats not configured");
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.STATS_ACCOUNT_ID}/analytics_engine/sql`, {
      method: "POST", headers: { Authorization: `Bearer ${env.STATS_AE_TOKEN}`, "Content-Type": "text/plain" },
      body: `${sql} FORMAT JSON`, signal: AbortSignal.timeout(10_000), redirect: "error",
    });
    if (!response.ok) throw new Error("Query unavailable");
    const body = await response.json() as { data?: Row[]; rows?: number };
    if (!Array.isArray(body.data) || body.data.length > 1000 || (typeof body.rows === "number" && body.rows !== body.data.length) ||
      body.data.some(row => !row || typeof row !== "object" || Array.isArray(row) || Object.values(row).some(value => value !== null && typeof value !== "string" && typeof value !== "number"))) throw new Error("Invalid query result");
    return { rows: body.data, failed: false };
  } catch {
    return { rows: [], failed: true };
  }
}
const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const count = (value: unknown): number => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
const numberText = (value: unknown) => count(value).toLocaleString("en-US");
const unavailable = '<p class="error" role="status">Data unavailable. Try refreshing shortly.</p>';
function breakdown(title: string, result: QueryResult): string {
  return `<section><h2>${title}</h2><p class="muted">Distinct active IDs · last 30 days · top 100</p>${result.failed ? unavailable : result.rows.length ? `<table><thead><tr><th scope="col">${title}</th><th scope="col">Installs</th></tr></thead><tbody>${result.rows.map(row => `<tr><th scope="row">${escapeHtml(row.label || "Unknown")}</th><td>${numberText(row.total)}</td></tr>`).join("")}</tbody></table>` : '<p class="muted">No pings in this period.</p>'}</section>`;
}
function chart(title: string, days: string[], rows: Row[], color: string): string {
  const values = days.map(day => count(rows.find(row => String(row.day).slice(0, 10) === day)?.total));
  const max = Math.max(1, ...values);
  const bars = values.map((value, i) => `<rect x="${32 + i * 20}" y="${150 - value / max * 120}" width="13" height="${value / max * 120}" rx="2" fill="${color}"><title>${days[i]}: ${numberText(value)}</title></rect>`).join("");
  const ticks = [0, 7, 14, 21, 29].map(i => `<text x="${38 + i * 20}" y="175" text-anchor="middle">${days[i].slice(5)}</text>`).join("");
  return `<figure><svg viewBox="0 0 650 190" role="img" aria-label="${escapeHtml(title)}"><title>${escapeHtml(title)}</title><text x="8" y="24">${numberText(max)}</text><path d="M30 30H635 M30 90H635 M30 150H635" stroke="#334155" stroke-width="1"/>${bars}${ticks}</svg><figcaption>${numberText(values.reduce((a, b) => a + b, 0))} across daily counts · peak ${numberText(Math.max(...values))}</figcaption></figure>`;
}

async function statsResponse(request: Request, env: Env): Promise<Response> {
  const headers = { "Cache-Control": "private, no-store", "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
  if (!await validAccess(request, env)) return new Response("Forbidden", { status: 403, headers });
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET" } });
  const now = new Date();
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const days = Array.from({ length: 30 }, (_, i) => new Date(today.getTime() - (29 - i) * 86_400_000).toISOString().slice(0, 10));
  const stamp = (date: string) => `toDateTime('${date.replace("T", " ").replace(/\.\d{3}Z$/, "")}')`;
  const upper = stamp(now.toISOString());
  const start = (day: string) => stamp(`${day}T00:00:00.000Z`);
  const window = (day: string) => `timestamp >= ${start(day)} AND timestamp <= ${upper}`;
  const last30 = window(days[0]);
  // First-seen scans all retained history, then filters the minimum into the display window.
  const retained = `timestamp >= ${upper} - INTERVAL '3' MONTH AND timestamp <= ${upper}`;
  const queries = [
    ...[days[29], days[23], days[0]].map(day => `SELECT count(DISTINCT blob1) AS total FROM installs WHERE ${window(day)} LIMIT 1`),
    `SELECT formatDateTime(timestamp, '%Y-%m-%d') AS day, count(DISTINCT blob1) AS total FROM installs WHERE ${last30} GROUP BY day ORDER BY day LIMIT 30`,
    `SELECT formatDateTime(first_seen, '%Y-%m-%d') AS day, count() AS total FROM (SELECT blob1, min(timestamp) AS first_seen FROM installs WHERE ${retained} GROUP BY blob1) WHERE first_seen >= ${start(days[0])} GROUP BY day ORDER BY day LIMIT 30`,
    `SELECT blob2 AS label, count(DISTINCT blob1) AS total FROM installs WHERE ${last30} GROUP BY label ORDER BY total DESC, label LIMIT 100`,
    `SELECT blob3 AS os, blob4 AS arch, count(DISTINCT blob1) AS total FROM installs WHERE ${last30} GROUP BY os, arch ORDER BY total DESC, os, arch LIMIT 100`,
    `SELECT blob5 AS label, count(DISTINCT blob1) AS total FROM installs WHERE ${last30} GROUP BY label ORDER BY total DESC, label LIMIT 100`,
    `SELECT formatDateTime(timestamp, '%Y-%m-%d') AS day, blob1 AS event, sum(_sample_interval * double1) AS total FROM site_events WHERE ${last30} GROUP BY day, event ORDER BY day, event LIMIT 120`,
    `SELECT max(timestamp) AS newest FROM installs WHERE ${retained} LIMIT 1`,
  ];
  const results = await Promise.all(queries.map(sql => statsQuery(env, sql)));
  const [active, fresh, versions, platforms, kinds, actions, newest] = results.slice(3);
  const dailySection = (title: string, result: QueryResult, color: string) => `<section><h2>${title}</h2>${result.failed ? unavailable : chart(title, days, result.rows, color)}</section>`;
  const events = [...new Set(actions.rows.map(row => String(row.event)))].sort();
  const newestValue = newest.rows[0]?.newest;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Delegatus · Stats</title><style>
  :root{color-scheme:dark;font-family:system-ui,sans-serif;background:#0b1120;color:#e2e8f0}*{box-sizing:border-box}body{margin:0}main{max-width:1200px;margin:auto;padding:32px 24px 48px}header{margin-bottom:24px}h1{font-size:32px;letter-spacing:-1px;margin:8px 0}h2{font-size:18px;margin:0 0 12px}p{line-height:1.5}.eyebrow{color:#a5b4fc;font-size:12px;letter-spacing:2px;text-transform:uppercase}.muted,figcaption{color:#94a3b8;font-size:13px}.cards,.grid{display:grid;gap:16px}.cards,.breakdowns{grid-template-columns:repeat(3,minmax(0,1fr))}.charts{grid-template-columns:repeat(2,minmax(0,1fr))}section,.card{background:#111b2e;border:1px solid #26334a;border-radius:14px;padding:20px;min-width:0;margin-bottom:16px}.card strong{display:block;font-size:36px;font-weight:650;margin-top:8px}.error{color:#fda4af}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:10px 0;text-align:left;border-bottom:1px solid #26334a;overflow-wrap:anywhere}thead th{font-weight:500;color:#94a3b8}tbody th{font-weight:400}td,th:last-child{text-align:right}svg{display:block;width:100%;height:auto}svg text{fill:#94a3b8;font-size:16px}figure{margin:0}figcaption{margin-top:6px}.newest{overflow-wrap:anywhere}@media(max-width:700px){main{padding:24px 16px}h1{font-size:28px}.cards{gap:8px}.card{padding:12px 10px}.card strong{font-size:28px}.card span{font-size:12px}.charts,.breakdowns{grid-template-columns:1fr}section{padding:16px}svg text{font-size:24px}}
  </style></head><body><main><header><div class="eyebrow">Delegatus · Private analytics</div><h1>Installation stats</h1><p class="muted">${days[0]} – ${days[29]} · UTC · today is partial</p><p class="newest">Newest ping: ${newest.failed ? '<span class="error">Data unavailable</span>' : !newestValue || String(newestValue).startsWith("1970-01-01") ? "No retained pings" : `${escapeHtml(newestValue)} UTC`}</p></header>
  <div class="cards">${["Today", "Last 7 days", "Last 30 days"].map((label, i) => `<div class="card"><span>${label}</span><strong>${results[i].failed ? "—" : numberText(results[i].rows[0]?.total)}</strong><span class="muted">Active installs</span>${results[i].failed ? unavailable : ""}</div>`).join("")}</div>
  <div class="grid charts">${dailySection("Daily active installs", active, "#818cf8")}${dailySection("New installs per day", fresh, "#2dd4bf")}</div>
  <p class="muted">Active installs count distinct random IDs. New installs use the first ping in the retained three-month history; older returning IDs can appear new. Daily active counts can include the same ID on multiple days. Sampling may undercount distinct IDs.</p>
  <div class="grid breakdowns">${breakdown("Version", versions)}${breakdown("OS / architecture", { ...platforms, rows: platforms.rows.map(row => ({ ...row, label: `${row.os} / ${row.arch}` })) })}${breakdown("Install kind", kinds)}</div>
  <section><h2>Landing actions per day</h2><p class="muted">Last 30 days · counts weighted for sampling</p>${actions.failed ? unavailable : events.length ? `<div class="grid charts">${events.map(event => `<div><h3>${escapeHtml(event.replace(/_/g, " "))}</h3>${chart(event, days, actions.rows.filter(row => row.event === event), "#fbbf24")}</div>`).join("")}</div>` : '<p class="muted">No landing actions in this period.</p>'}</section>
  <footer class="muted">Generated ${escapeHtml(now.toISOString())} · ID resets count as new installs. An ID may appear in several breakdown rows after an update or configuration change.</footer></main></body></html>`;
  return new Response(html, { status: 200, headers });
}
