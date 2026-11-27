import type { DurableObjectId } from "cloudflare:workers";
import { countryCode, isInstallPing, isSiteEvent } from "./stats/metrics";
import { type QueryResult, type Row } from "./stats/history";
import { SESSION_SECONDS, type Snapshot, type StatsClient, type StatsSettings } from "./stats/store";
import { base64url, bytes, randomBytes } from "./stats/webauthn";

export interface Env extends StatsSettings {
  ASSETS: { fetch(request: Request): Promise<Response> };
  STATS: { idFromName(name: string): DurableObjectId; get(id: DurableObjectId): StatsClient };
}

function statsStore(env: Env) {
  return env.STATS.get(env.STATS.idFromName("stats"));
}

// Bound even a chunked body before parsing it; events are under 100 bytes.
async function readText(request: Request, limit: number): Promise<string | null> {
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
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function readBody(request: Request, limit: number): Promise<unknown> {
  const text = await readText(request, limit);
  return text === null ? null : JSON.parse(text);
}

const reply = (status: number, text?: string, headers?: HeadersInit) =>
  new Response(text, { status, headers: { "Cache-Control": "no-store", ...headers } });

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/stats" || pathname.startsWith("/stats/")) {
      return statsResponse(request, env).catch(() => statsReply(503));
    }
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
    const country = countryCode(cf?.country);
    if (pathname === "/api/ping") {
      if (!isInstallPing(body)) return reply(400, "Invalid ping");
      await statsStore(env).recordPing(body, country, Date.now());
      return reply(204);
    }
    if (!isSiteEvent(body)) return reply(400, "Invalid event");
    await statsStore(env).recordEvent(body, country, Date.now());
    return reply(204);
  },
};

export default worker;

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

function swarmTable(result: QueryResult): string {
  return `<section><h2>Swarm rule usage</h2><p class="muted">Last 30 days · reporting install-days count anonymous submissions; repeat submissions can inflate totals.</p>${result.failed ? unavailable : result.rows.length ? `<table class="swarm-usage"><thead><tr><th scope="col">Rule</th><th scope="col">Reporting install-days</th><th scope="col">Deliveries</th><th scope="col">Applied rate</th><th scope="col">Misled</th><th scope="col">Misled install-days</th></tr></thead><tbody>${result.rows.map(row => `<tr><th scope="row">${escapeHtml(row.rule)}</th><td><span class="swarm-label">Reporting install-days</span>${numberText(row.reports)}</td><td><span class="swarm-label">Deliveries</span>${numberText(row.delivered)}</td><td><span class="swarm-label">Applied rate</span>${count(row.delivered) ? `${(100 * count(row.applied) / count(row.delivered)).toFixed(1)}%` : "—"}</td><td><span class="swarm-label">Misled</span>${numberText(row.misled)}</td><td><span class="swarm-label">Misled install-days</span>${numberText(row.misled_reports)}</td></tr>`).join("")}</tbody></table>` : '<p class="muted">No swarm usage in this period.</p>'}</section>`;
}

function renderStats(snapshot: Snapshot): string {
  // A same-origin form POST needs Origin even with the response no-referrer header.
  const { days, results, access } = snapshot;
  const now = new Date(snapshot.now);
  const [active, fresh, versions, platforms, kinds, actions, newest, swarm] = results.slice(3);
  const dailySection = (title: string, result: QueryResult, color: string) => `<section><h2>${title}</h2>${result.failed ? unavailable : chart(title, days, result.rows, color)}</section>`;
  const events = [...new Set(actions.rows.map(row => String(row.event)))].sort();
  const newestValue = newest.rows[0]?.newest;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="same-origin"><title>Delegatus · Stats</title><style>
  :root{color-scheme:dark;font-family:system-ui,sans-serif;background:#0b1120;color:#e2e8f0}*{box-sizing:border-box}body{margin:0}main{max-width:1200px;margin:auto;padding:32px 24px 48px}header{margin-bottom:24px}h1{font-size:32px;letter-spacing:-1px;margin:8px 0}h2{font-size:18px;margin:0 0 12px}p{line-height:1.5}.eyebrow{color:#a5b4fc;font-size:12px;letter-spacing:2px;text-transform:uppercase}.muted,figcaption{color:#94a3b8;font-size:13px}.cards,.grid{display:grid;gap:16px}.cards,.breakdowns{grid-template-columns:repeat(3,minmax(0,1fr))}.charts{grid-template-columns:repeat(2,minmax(0,1fr))}section,.card{background:#111b2e;border:1px solid #26334a;border-radius:14px;padding:20px;min-width:0;margin-bottom:16px}.card strong{display:block;font-size:36px;font-weight:650;margin-top:8px}.error{color:#fda4af}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:10px 0;text-align:left;border-bottom:1px solid #26334a;overflow-wrap:anywhere}thead th{font-weight:500;color:#94a3b8}tbody th{font-weight:400}.swarm-label{display:none}td,th:last-child{text-align:right}svg{display:block;width:100%;height:auto}svg text{fill:#94a3b8;font-size:16px}figure{margin:0}figcaption{margin-top:6px}.newest{overflow-wrap:anywhere}.access-actions{display:flex;flex-wrap:wrap;gap:10px}.passkeys{padding-left:20px}.passkeys li{margin:10px 0}.passkeys form{display:inline-block;margin-left:10px}button{font:inherit;background:#253553;color:inherit;border:1px solid #506083;border-radius:8px;padding:7px 12px;cursor:pointer}@media(max-width:700px){main{padding:24px 16px}h1{font-size:28px}.cards{gap:8px}.card{padding:12px 10px}.card strong{font-size:28px}.card span{font-size:12px}.charts,.breakdowns{grid-template-columns:1fr}section{padding:16px}svg text{font-size:24px}.swarm-usage,.swarm-usage tbody,.swarm-usage tr{display:block}.swarm-usage thead{display:none}.swarm-usage tbody th{display:block;text-align:left;font-weight:600}.swarm-usage td{display:flex;justify-content:space-between;gap:16px;text-align:right}.swarm-usage .swarm-label{display:block;text-align:left;color:#94a3b8}.swarm-usage tr+tr{margin-top:16px}}
  </style></head><body><main><header><div class="eyebrow">Delegatus · Private analytics</div><h1>Installation stats</h1><p class="muted">${days[0]} – ${days[29]} · UTC · today is partial</p><p class="newest">Newest ping: ${newest.failed ? '<span class="error">Data unavailable</span>' : !newestValue || String(newestValue).startsWith("1970-01-01") ? "No retained pings" : `${escapeHtml(newestValue)} UTC`}</p></header>
  <div class="cards">${["Today", "Last 7 days", "Last 30 days"].map((label, i) => `<div class="card"><span>${label}</span><strong>${results[i].failed ? "—" : numberText(results[i].rows[0]?.total)}</strong><span class="muted">Active installs</span>${results[i].failed ? unavailable : ""}</div>`).join("")}</div>
  <div class="grid charts">${dailySection("Daily active installs", active, "#818cf8")}${dailySection("New installs per day", fresh, "#2dd4bf")}</div>
  <p class="muted">Active installs count distinct random IDs. New installs use the first ping in the retained three-month history; older returning IDs can appear new. Daily active counts can include the same ID on multiple days.</p>
  <div class="grid breakdowns">${breakdown("Version", versions)}${breakdown("OS / architecture", { ...platforms, rows: platforms.rows.map(row => ({ ...row, label: `${row.os} / ${row.arch}` })) })}${breakdown("Install kind", kinds)}</div>
  <section><h2>Landing actions per day</h2><p class="muted">Last 30 days</p>${actions.failed ? unavailable : events.length ? `<div class="grid charts">${events.map(event => `<div><h3>${escapeHtml(event.replace(/_/g, " "))}</h3>${chart(event, days, actions.rows.filter(row => row.event === event), "#fbbf24")}</div>`).join("")}</div>` : '<p class="muted">No landing actions in this period.</p>'}</section>
  ${swarmTable(swarm)}
  <section><h2>Access</h2><p class="muted">${escapeHtml(access.importStatus)}</p>
  <div class="access-actions">${accessForm("/stats/logout", "Sign out")}${accessForm("/stats/sessions/revoke", "Sign out on all devices")}</div>
  ${access.passkeys.length ? `<ul class="passkeys">${access.passkeys.map(key =>
    `<li>${key.id === access.currentCredentialId ? "This device · " : ""}Added ${new Date(key.created_at).toISOString().slice(0, 16).replace("T", " ")} UTC · ${key.last_used_at === null ? "Never used to sign in" : `Last used ${new Date(key.last_used_at).toISOString().slice(0, 10)}`}
    ${accessForm("/stats/passkeys/remove", "Remove", key.id)}</li>`).join("")}</ul>` : ""}</section>
  <footer class="muted">Generated ${escapeHtml(now.toISOString())} · ID resets count as new installs. An ID may appear in several breakdown rows after an update or configuration change.</footer></main></body></html>`;
}

function accessForm(action: string, label: string, id?: string) {
  return `<form method="post" action="${action}">${id === undefined ? "" :
    `<input type="hidden" name="id" value="${escapeHtml(id)}">`}<button type="submit">${label}</button></form>`;
}

const cookieName = "__Host-dlg_stats";
const cookie = (value: string, maxAge: number) =>
  `${cookieName}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`;

function sessionToken(request: Request) {
  const values = (request.headers.get("Cookie") ?? "").split(";").map(part => part.trim())
    .filter(part => part.split("=")[0].trim() === cookieName);
  if (values.length !== 1 || !values[0].startsWith(cookieName + "=")) return null;
  const value = values[0].slice(cookieName.length + 1);
  try { bytes(value, 32); return value; } catch { return null; }
}

const statsCsp = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
function statsReply(status: number, body: string | null = null, extra?: HeadersInit) {
  return new Response(body, { status, headers: {
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": statsCsp, ...extra,
  } });
}

function authPage(enroll: boolean) {
  const nonce = base64url(randomBytes(16));
  const title = enroll ? "Set up a passkey" : "Sign in to stats";
  const label = enroll ? "Create passkey" : "Sign in with passkey";
  return statsReply(enroll ? 200 : 401, `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>${title} · Delegatus</title><style>
:root{color-scheme:dark;background:#0b1120;color:#e2e8f0;font:16px system-ui,sans-serif}
body{margin:0}main{max-width:26rem;margin:12vh auto 0;padding:24px}section{background:#111b2e;border:1px solid #26334a;border-radius:14px;padding:24px}
h1{font-size:1.65rem;margin:0 0 16px}p{line-height:1.5;color:#c1cce0}button{font:inherit;background:#253553;color:inherit;border:1px solid #506083;border-radius:8px;padding:9px 14px;cursor:pointer}button:disabled{opacity:.65}
</style></head><body><main><section><h1>${title}</h1><button id="action" hidden>${label}</button>
<p id="status" role="status"></p><noscript>Enable JavaScript to use a passkey.</noscript></section></main>
<script nonce="${nonce}">
(async () => {
  const enroll = ${enroll};
  let token = "";
  if (enroll) {
    token = location.hash.slice(1);
    history.replaceState(null, "", location.pathname);
  }
  const button = document.getElementById("action");
  const status = document.getElementById("status");
  const go = () => location.replace("/stats");
  if (!enroll) {
    try {
      if ((await fetch("/stats/session")).status === 204) { go(); return; }
    } catch {}
  }
  if (!window.PublicKeyCredential || !navigator.credentials ||
      (enroll && (!window.AuthenticatorAttestationResponse ||
        !AuthenticatorAttestationResponse.prototype.getPublicKey ||
        !AuthenticatorAttestationResponse.prototype.getPublicKeyAlgorithm ||
        !AuthenticatorAttestationResponse.prototype.getAuthenticatorData))) {
    status.textContent = "This browser cannot use passkeys here.";
    return;
  }
  const linkError = "This enrollment link is invalid, expired or already used.";
  if (enroll && !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    status.textContent = linkError;
    return;
  }
  const mode = enroll ? "enroll" : "login";
  const decode = value => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  const encode = value => btoa(String.fromCharCode(...new Uint8Array(value))).split("+").join("-").split("/").join("_").replace(/=+$/, "");
  const send = (step, body) => fetch("/stats/" + mode + "/" + step, {
    method: "POST", referrerPolicy: "same-origin",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  button.hidden = false;
  button.onclick = async () => {
    button.disabled = true;
    status.textContent = "";
    try {
      const response = await send("options", enroll ? { token } : undefined);
      if (enroll && response.status === 403) {
        status.textContent = linkError;
        button.hidden = true;
        return;
      }
      if (!response.ok) throw new Error();
      const publicKey = await response.json();
      publicKey.challenge = decode(publicKey.challenge);
      if (enroll) publicKey.user.id = decode(publicKey.user.id);
      const credential = await (enroll ? navigator.credentials.create({ publicKey }) : navigator.credentials.get({ publicKey }));
      const proof = credential.response;
      const input = {
        id: encode(credential.rawId), clientDataJSON: encode(proof.clientDataJSON),
        authenticatorData: encode(enroll ? proof.getAuthenticatorData() : proof.authenticatorData),
        ...(enroll ? { token, publicKey: encode(proof.getPublicKey()), alg: proof.getPublicKeyAlgorithm() } :
          { signature: encode(proof.signature), userHandle: proof.userHandle === null ? null : encode(proof.userHandle) }),
      };
      const finish = await send("finish", input);
      if (finish.status === 204) { go(); return; }
      status.textContent = enroll ? linkError : "Sign-in was refused. Try again.";
    } catch {
      status.textContent = enroll ? "Could not create a passkey. Try again." : "Could not sign in. Try again.";
    } finally {
      button.disabled = false;
    }
  };
})();
</script></body></html>`, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `${statsCsp}; script-src 'nonce-${nonce}'; connect-src 'self'`,
  });
}

const statsMethods = new Map([
  ["/stats", "GET"], ["/stats/", "GET"], ["/stats/session", "GET"], ["/stats/enroll", "GET"],
  ["/stats/enroll/options", "POST"], ["/stats/enroll/finish", "POST"], ["/stats/login/options", "POST"],
  ["/stats/login/finish", "POST"], ["/stats/logout", "POST"], ["/stats/sessions/revoke", "POST"],
  ["/stats/passkeys/remove", "POST"],
]);

async function statsResponse(request: Request, env: Env): Promise<Response> {
  const { origin, hostname, pathname, search } = new URL(request.url);
  if (origin !== env.STATS_ORIGIN) {
    if (hostname === "www." + env.STATS_RP_ID && request.method === "GET") {
      return statsReply(308, null, { Location: env.STATS_ORIGIN + pathname + search });
    }
    return statsReply(403);
  }
  const method = statsMethods.get(pathname);
  if (!method) return statsReply(404);
  if (request.method !== method) return statsReply(405, null, { Allow: method });
  if (method === "GET") {
    if (pathname === "/stats/enroll") return authPage(true);
    const token = sessionToken(request);
    if (pathname === "/stats/session") {
      return statsReply(token && await statsStore(env).session(token) ? 204 : 401);
    }
    const snapshot = token && await statsStore(env).snapshot(token);
    return snapshot ? statsReply(200, renderStats(snapshot), { "Content-Type": "text/html; charset=utf-8" }) : authPage(false);
  }

  if (request.headers.get("Origin") !== env.STATS_ORIGIN) return statsReply(403);
  const contentType = request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (pathname === "/stats/login/options") {
    if (request.body && await readText(request, 0).catch(() => null) !== "") return statsReply(401);
    return statsReply(200, JSON.stringify(await statsStore(env).loginOptions()), { "Content-Type": "application/json" });
  }
  if (pathname === "/stats/enroll/options" || pathname.endsWith("/finish")) {
    if (contentType !== "application/json") return statsReply(415);
    const status = pathname.startsWith("/stats/enroll/") ? 403 : 401;
    const body = await readBody(request, pathname.endsWith("/options") ? 512 : 8192).catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return statsReply(status);
    const input = body as Record<string, unknown>;
    const store = statsStore(env);
    if (pathname === "/stats/enroll/options") {
      const options = await store.enrollmentOptions(input.token);
      return options ? statsReply(200, JSON.stringify(options), { "Content-Type": "application/json" }) : statsReply(403);
    }
    const token = await (pathname === "/stats/enroll/finish" ? store.enroll(input) : store.login(input));
    return token ? statsReply(204, null, { "Set-Cookie": cookie(token, SESSION_SECONDS) }) : statsReply(status);
  }

  const token = sessionToken(request);
  if (!token) return statsReply(401);
  if (contentType !== "application/x-www-form-urlencoded") return statsReply(415);
  const form = await readText(request, 2048).catch(() => null);
  // A request with an empty form may have no body.
  if (form === null && request.body) return statsReply(403);
  const mode = pathname === "/stats/logout" ? "current" : pathname === "/stats/sessions/revoke" ? "all" : "passkey";
  const ids = new URLSearchParams(form ?? "").getAll("id");
  if (mode === "passkey" && (ids.length !== 1 || !/^[\w-]{22,1364}$/.test(ids[0]))) return statsReply(403);
  const valid = await statsStore(env).revoke(token, mode, ids[0] ?? "");
  if (valid === null) return statsReply(401);
  return statsReply(303, null, valid ? { Location: "/stats" } : { Location: "/stats", "Set-Cookie": cookie("", 0) });
}
