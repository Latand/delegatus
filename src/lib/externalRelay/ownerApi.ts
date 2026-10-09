import fs from "node:fs";
import { createHash } from "node:crypto";
import { statePath } from "@/lib/configDir";
import { ExternalRelayError, relayCall, readRelayJsonUrl, checkApiBase } from "./client";
import { ownerApiSchema, ownerApiMeSchema, type ExternalRelayRequest, type ExternalRelayTool } from "./protocol";
import { readRelaySwitches } from "./switches";
import { withFileLock, writeRelayFile, readRelayStore, type PairedRelay } from "./store";
import { toolSleep, type ToolLoopRuntime } from "./toolLoop";
type KeyEntry = { relayId: string; ownerNamespace: string; ownerId: string; key: string; expiresAt: string | null; boundAt: string };
export type OwnerApiView = { offered: true; state: "none" | "bound" | "expired" | "rejected"; boundAt: string | null; expiresAt: string | null; keyUrl: string };
const keyFile = () => statePath("external-relay/owner-keys.json");
function keys(): KeyEntry[] {
  try { const value = JSON.parse(fs.readFileSync(keyFile(), "utf8")); if (value.v !== 1 || !Array.isArray(value.keys)) throw new Error("invalid owner key store"); return value.keys; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function put(relayId: string, entry?: KeyEntry) { withFileLock(keyFile(), () => writeRelayFile(keyFile(), { v: 1, keys: [...keys().filter((k) => k.relayId !== relayId), ...(entry ? [entry] : [])] })); }
type KeyStatus = { relayId: string; ownerNamespace: string; ownerId: string; state: "expired" | "rejected"; expiresAt: string | null };
const statusFile = () => statePath("external-relay/owner-key-status.json");
function statuses(): KeyStatus[] {
  try { return JSON.parse(fs.readFileSync(statusFile(), "utf8")).states; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function changeStatus(id: string, next?: KeyStatus) {
  if (!next && !fs.existsSync(statusFile())) return;
  withFileLock(statusFile(), () => writeRelayFile(statusFile(), { v: 1, states: [...statuses().filter((s) => s.relayId !== id), ...(next ? [next] : [])] }));
}
export function forgetOwnerKey(relayId: string) { discoveryCache.delete(cacheKey(relayId)); if (fs.existsSync(keyFile())) put(relayId); changeStatus(relayId); }
function invalidate(relay: PairedRelay, state: "expired" | "rejected", expiresAt: string | null = null) {
  forgetOwnerKey(relay.id);
  changeStatus(relay.id, { relayId: relay.id, ownerNamespace: relay.owner.namespace, ownerId: relay.owner.id, state, expiresAt });
}
function entryFor(relay: PairedRelay, now = Date.now()) {
  const entry = keys().find((k) => k.relayId === relay.id);
  if (!entry) return null;
  const current = readRelayStore().relays.find((r) => r.id === relay.id);
  if (!current || current.owner.namespace !== entry.ownerNamespace || current.owner.id !== entry.ownerId) { forgetOwnerKey(relay.id); return null; }
  if (entry.ownerNamespace !== relay.owner.namespace || entry.ownerId !== relay.owner.id) { forgetOwnerKey(relay.id); return null; }
  if (entry.expiresAt && Date.parse(entry.expiresAt) <= now) { invalidate(relay, "expired", entry.expiresAt); return null; }
  return entry;
}
export function sweepOwnerKeys(relays: PairedRelay[]) {
  for (const entry of keys()) { const relay = relays.find((r) => r.id === entry.relayId); if (!relay) forgetOwnerKey(entry.relayId); else entryFor(relay); }
}
async function descriptorFor(relay: PairedRelay) {
  if (!readRelaySwitches().owner_api || relay.owner.namespace !== "telegram") return null;
  try {
    const value = ownerApiSchema.parse(await readRelayJsonUrl(`${relay.origin}/.well-known/delegatus-relay.json`)).owner_api;
    checkApiBase(relay.origin, value.api_base);
    if (value.api_base === relay.api_base) return null;
    const link = new URL(value.key_url);
    if (link.username || link.password || !["https:", "http:"].includes(link.protocol) || link.protocol === "http:" && link.origin !== relay.origin) return null;
    const openapi = new URL(value.openapi_url);
    if (openapi.origin !== relay.origin || openapi.username || openapi.password || openapi.search || openapi.hash) return null;
    return value;
  } catch { return null; }
}
export async function ownerApiView(relay: PairedRelay): Promise<OwnerApiView | null> {
  const descriptor = await descriptorFor(relay); if (!descriptor) return null;
  const before = keys().find((k) => k.relayId === relay.id); const entry = entryFor(relay);
  const status = statuses().find((s) => s.relayId === relay.id && s.ownerNamespace === relay.owner.namespace && s.ownerId === relay.owner.id);
  return { offered: true, state: entry ? "bound" : status?.state ?? "none",
    boundAt: entry?.boundAt ?? null, expiresAt: entry?.expiresAt ?? before?.expiresAt ?? status?.expiresAt ?? null, keyUrl: descriptor.key_url };
}
type Window = { times: number[]; blockedUntil: number };
const globalOwner = globalThis as typeof globalThis & { __relayOwnerWindows?: Map<string, Window> };
const windows = (globalOwner.__relayOwnerWindows ??= new Map<string, Window>());
function windowFor(key: string) {
  const id = createHash("sha256").update(keyFile() + key).digest("hex");
  let value = windows.get(id); if (!value) { value = { times: [], blockedUntil: 0 }; windows.set(id, value); } return value;
}
async function admit(key: string, signal: AbortSignal, runtime: ToolLoopRuntime) {
  const now = runtime.now ?? Date.now; const sleep = runtime.sleep ?? toolSleep; const window = windowFor(key);
  while (true) {
    signal.throwIfAborted(); const current = now(); window.times = window.times.filter((t) => t > current - 60000);
    const until = Math.max(window.blockedUntil, window.times.length >= 60 ? window.times[0]! + 60000 : current);
    if (until <= current) { window.times.push(current); return; }
    if (until - current > 60000) throw new ExternalRelayError("rate_limited", 429);
    await sleep(until - current, signal);
  }
}
export async function bindOwnerKey(relay: PairedRelay, key: string): Promise<OwnerApiView> {
  if (!/^clst_[\x21-\x7e]{1,507}$/.test(key)) throw new ExternalRelayError("refused_here", 400);
  const current = readRelayStore().relays.find((r) => r.id === relay.id);
  if (!current || current.owner.namespace !== relay.owner.namespace || current.owner.id !== relay.owner.id) throw new ExternalRelayError("owner_api_unavailable", 409);
  const descriptor = await descriptorFor(relay); if (!descriptor) throw new ExternalRelayError("owner_api_unavailable", 409);
  const signal = new AbortController().signal;
  await admit(key, signal, {});
  let value;
  try { value = ownerApiMeSchema.parse((await relayCall(descriptor.api_base, "/me", "GET", undefined, key)).body); }
  catch (error) {
    if (error instanceof ExternalRelayError && error.status === 401) { invalidate(relay, "rejected"); throw new ExternalRelayError("key_rejected", 409); }
    if (error instanceof ExternalRelayError && error.status === 429) { windowFor(key).blockedUntil = Date.now() + Math.min(60, Math.max(1, error.retryAfterSeconds ?? 1)) * 1000; throw new ExternalRelayError("rate_limited", 429); }
    throw new ExternalRelayError(error instanceof ExternalRelayError ? "unreachable" : "malformed", 502);
  }
  if (String(value.user_id) !== relay.owner.id) { forgetOwnerKey(relay.id); throw new ExternalRelayError("owner_mismatch", 409); }
  if (value.expires_at && Date.parse(value.expires_at) <= Date.now()) { invalidate(relay, "expired", value.expires_at); throw new ExternalRelayError("key_expired", 409); }
  const stillPaired = readRelayStore().relays.find((r) => r.id === relay.id);
  if (!stillPaired || stillPaired.owner.namespace !== relay.owner.namespace || stillPaired.owner.id !== relay.owner.id) throw new ExternalRelayError("owner_api_unavailable", 409);
  discoveryCache.delete(cacheKey(relay.id)); changeStatus(relay.id);
  put(relay.id, { relayId: relay.id, ownerNamespace: relay.owner.namespace, ownerId: relay.owner.id, key, expiresAt: value.expires_at ?? null, boundAt: new Date().toISOString() });
  return { offered: true, state: "bound", boundAt: keys().find((k) => k.relayId === relay.id)!.boundAt, expiresAt: value.expires_at ?? null, keyUrl: descriptor.key_url };
}
type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
function resolveSchema(value: unknown, document: Json, depth = 0, seen: string[] = []): unknown {
  if (depth > 8) return {};
  if (Array.isArray(value)) return value.map((v) => resolveSchema(v, document, depth + 1, seen));
  if (!value || typeof value !== "object") return value;
  const row = object(value);
  if (typeof row.$ref === "string") {
    if (!row.$ref.startsWith("#/") || seen.includes(row.$ref)) return {};
    const resolved = row.$ref.slice(2).split("/").reduce<unknown>((v, k) => object(v)[k.replaceAll("~1", "/").replaceAll("~0", "~")], document);
    return resolveSchema(resolved, document, depth + 1, [...seen, row.$ref]);
  }
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, resolveSchema(v, document, depth + 1, seen)]));
}
export type OwnerTool = ExternalRelayTool & { apiBase: string; route: string; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" };
const discoveryCache = new Map<string, { origin: string; apiBase: string; until: number; tools: OwnerTool[] }>();
const cacheKey = (id: string) => keyFile() + ":" + id;
export async function ownerToolsFor(relay: PairedRelay, request: ExternalRelayRequest): Promise<OwnerTool[]> {
  if (!readRelaySwitches().owner_api || !request.input.requester?.is_owner || !entryFor(relay)) return [];
  const visible = (tools: OwnerTool[]) => tools.filter((tool) => !request.input.tools?.some((t) => t.name === tool.name));
  const cached = discoveryCache.get(cacheKey(relay.id));
  if (cached && cached.origin === relay.origin && cached.apiBase === relay.api_base && cached.until > Date.now()) return visible(cached.tools);
  try {
    const descriptor = await descriptorFor(relay); if (!descriptor) return [];
    const document = object(await readRelayJsonUrl(descriptor.openapi_url)); const tools: OwnerTool[] = [];
    const prefix = new URL(descriptor.api_base).pathname;
    for (const [pathname, raw] of Object.entries(object(document.paths))) {
      if (!pathname.startsWith(prefix + "/") || pathname.includes("..") || pathname.includes("?") || pathname.includes("#")) continue;
      const pathItem = object(raw);
      for (const method of ["get", "post", "put", "patch", "delete"] as const) {
        const operation = object(pathItem[method]); const name = operation.operationId;
        if (typeof name !== "string" || !descriptor.operations.includes(name) || name.length > 64 || pathname === prefix + "/me" && method === "get") continue;
        const params = [...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])].map((p) => object(resolveSchema(p, document)));
        if (params.some((p) => !["path", "query"].includes(String(p.in)))) continue;
        const properties: Json = {}; const required: string[] = [];
        for (const location of ["path", "query"]) {
          const selected = params.filter((p) => p.in === location);
          if (selected.length) { properties[location] = { type: "object", additionalProperties: false, properties: Object.fromEntries(selected.map((p) => [String(p.name), resolveSchema(p.schema, document)])), required: selected.filter((p) => p.required || location === "path").map((p) => String(p.name)) }; if (location === "path" || selected.some((p) => p.required)) required.push(location); }
        }
        const body = object(resolveSchema(operation.requestBody, document));
        const schema = object(object(body.content)["application/json"]).schema;
        if (schema) { properties.body = resolveSchema(schema, document); if (body.required) required.push("body"); }
        const parameters = { type: "object", additionalProperties: false, properties, required };
        if (Buffer.byteLength(JSON.stringify(parameters)) > 8192) continue;
        tools.push({ name, summary: [...String(operation.summary ?? name)].slice(0, 240).join(""), effect: method === "get" ? "read" : "action", audience: "owner", mode: "direct", parameters,
          apiBase: descriptor.api_base, route: pathname.slice(prefix.length), method: method.toUpperCase() as OwnerTool["method"] });
      }
    }
    for (const [key, value] of discoveryCache) if (value.until <= Date.now()) discoveryCache.delete(key);
    if (discoveryCache.size >= 128) discoveryCache.delete(discoveryCache.keys().next().value!);
    discoveryCache.set(cacheKey(relay.id), { origin: relay.origin, apiBase: relay.api_base, until: Date.now() + 600000, tools });
    return visible(tools);
  } catch { return []; }
}
// Validate the subset needed by JSON OpenAPI parameters before any HTTP admission.
function valid(value: unknown, schema: unknown): boolean {
  const s = object(schema);
  if (Array.isArray(s.enum) && !s.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) return false;
  if (Array.isArray(s.anyOf)) return s.anyOf.some((v) => valid(value, v));
  if (Array.isArray(s.oneOf)) return s.oneOf.filter((v) => valid(value, v)).length === 1;
  if (Array.isArray(s.allOf) && !s.allOf.every((v) => valid(value, v))) return false;
  if (value === null) return s.nullable === true || s.type === "null";
  if (s.type === "object" || s.properties) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const row = object(value), props = object(s.properties);
    return (!Array.isArray(s.required) || s.required.every((k) => Object.hasOwn(row, String(k)))) && Object.entries(row).every(([k, v]) => Object.hasOwn(props, k) ? valid(v, props[k]) : s.additionalProperties !== false);
  }
  if (s.type === "array") return Array.isArray(value) && value.every((v) => valid(v, s.items));
  if (s.type === "integer" && (!Number.isInteger(value) || typeof value !== "number")) return false;
  if (s.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return false;
  if (s.type === "boolean" && typeof value !== "boolean" || s.type === "string" && typeof value !== "string") return false;
  if (typeof value === "string") {
    if (typeof s.maxLength === "number" && [...value].length > s.maxLength || typeof s.minLength === "number" && [...value].length < s.minLength) return false;
    if (typeof s.pattern === "string") { try { if (!new RegExp(s.pattern).test(value)) return false; } catch { return false; } }
  }
  if (typeof value === "number" && (typeof s.minimum === "number" && value < s.minimum || typeof s.maximum === "number" && value > s.maximum)) return false;
  return true;
}
export type OwnerCallResult = { status: "ok" | "error" | "denied" | "outcome_unknown"; output: string; truncated: boolean; code?: string; sent?: boolean };
function redactedJson(value: unknown, key: string): string {
  return JSON.stringify(value).replaceAll(JSON.stringify(key).slice(1, -1), "[redacted]").replaceAll(key, "[redacted]");
}
export async function callOwnerApi(relay: PairedRelay, tool: OwnerTool, args: Record<string, unknown>, budget: { calls: number }, signal: AbortSignal, runtime: ToolLoopRuntime = {}): Promise<OwnerCallResult> {
  const local = (code: string): OwnerCallResult => ({ status: "denied", output: "", truncated: false, code });
  if (!readRelaySwitches().owner_api) return local("not_permitted");
  if (!valid(args, tool.parameters)) return local("invalid_arguments");
  let route = tool.route;
  const scalar = (v: unknown) => ["string", "number", "boolean"].includes(typeof v);
  for (const [name, value] of Object.entries(object(args.path))) {
    if (!scalar(value) || value === "." || value === "..") return local("invalid_arguments");
    route = route.replaceAll(`{${name}}`, encodeURIComponent(String(value)));
  }
  if (/[{}]/.test(route)) return local("invalid_arguments");
  const query = new URLSearchParams(); for (const [name, value] of Object.entries(object(args.query))) { if (!scalar(value)) return local("invalid_arguments"); query.set(name, String(value)); }
  if (query.size) route += "?" + query.toString();
  const now = runtime.now ?? Date.now, sleep = runtime.sleep ?? toolSleep;
  let sent = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const entry = entryFor(relay, now()); if (!entry) return local("unauthorized");
    if (budget.calls >= 20) return local("too_many_calls");
    await admit(entry.key, signal, runtime); signal.throwIfAborted();
    // Re-check expiry after a rate-limit wait.
    const afterWait = entryFor(relay, now());
    if (!afterWait || afterWait.key !== entry.key) return local("unauthorized");
    if (budget.calls >= 20) return local("too_many_calls");
    budget.calls++; sent = true;
    try {
      checkApiBase(relay.origin, tool.apiBase);
      if (tool.apiBase === relay.api_base) return local("not_permitted");
      const response = await relayCall(tool.apiBase, route, tool.method, args.body, entry.key, { timeoutMs: 20000, maxBytes: 65536, signal });
      const text = response.body === null ? "" : redactedJson(response.body, entry.key);
      return { status: "ok", output: [...text].slice(0, 16000).join(""), truncated: [...text].length > 16000, sent };
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ExternalRelayError) {
        if (error.status === 401) { invalidate(relay, "rejected"); return { ...local("unauthorized"), sent, output: "The owner key was refused. Ask the owner to paste a new key in Delegatus." }; }
        if ([403, 404, 422].includes(error.status)) return { status: error.status === 403 ? "denied" : "error", output: [...redactedJson(object(error.payload).error ?? [], entry.key)].slice(0, 16000).join(""), truncated: false, code: error.status === 403 ? "not_permitted" : error.status === 404 ? "not_found" : "invalid_arguments", sent };
        if (error.status === 429) {
          const wait = Math.ceil(Math.min(60, Math.max(1, error.retryAfterSeconds ?? 1))) * 1000;
          windowFor(entry.key).blockedUntil = now() + wait;
          if (attempt < 3) { await sleep(wait, signal); continue; }
          return { ...local("rate_limited"), sent };
        }
      }
      if (tool.effect === "action") return { status: "outcome_unknown", output: "The service did not confirm whether this action happened.", truncated: false, sent };
      if (attempt < 3) { await sleep(1000 * 2 ** attempt, signal); continue; }
      return { status: "error", code: "unavailable", output: "", truncated: false, sent };
    }
  }
  return local("unavailable");
}
