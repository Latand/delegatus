import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { statePath } from "@/lib/configDir";
import { claudeProjectRoots } from "@/lib/accounts/claude";
import type { AccountContext } from "@/lib/accounts/contracts";
import type { ExternalRelayRequester, ExternalRelayRequest } from "./protocol";
import { externalRelayFile, runHoldsConversation, withFileLock, withFileLockAsync, writeRelayFile, type PairedRelay, type RelayTargetSettings, type RunRecord } from "./store";
import { relayRequestInFlight } from "./activity";
export type ConversationAuthority = "member" | "admin" | "owner" | "owner-tier";
export type RelayConversation = {
  id: string; relayId: string; targetId: string; chatKey: string; requesterKey: string; authority: ConversationAuthority; anchors: string[]; conversationId: string | null;
  engine: "claude" | "codex"; sessionId: string | null; accountId: string | null; cwd: string | null;
  turns: number; turnsSinceCompaction: number; createdAt: string; lastTurnAt: string;
  seen: string[]; staticDigest: string | null; lastPromptTokens: number | null; compactions: number;
  pendingCursor?: { operationId: string; seen: string[]; staticDigest: string };
  state: "idle" | "running" | "broken"; runningRequestId: string | null;
};
const file = () => statePath("external-relay/conversations.json");
type ConversationCacheEntry = { size: number; mtimeMs: number; ino: number; rows: RelayConversation[]; scopes: Map<string, RelayConversation[]> };
const cacheHost = globalThis as typeof globalThis & { __llvRelayConversationCache?: Map<string, ConversationCacheEntry> };
const conversationCache = cacheHost.__llvRelayConversationCache ??= new Map<string, ConversationCacheEntry>();
type RunLedgerCacheEntry = { size: number; mtimeMs: number; ino: number; runs: RunRecord[] };
const runCacheHost = globalThis as typeof globalThis & { __llvRelayRunLedgerCache?: Map<string, RunLedgerCacheEntry> };
const runLedgerCache = runCacheHost.__llvRelayRunLedgerCache ??= new Map<string, RunLedgerCacheEntry>();
function sameFileVersion(left: Pick<fs.Stats, "size" | "mtimeMs" | "ino">, right: Pick<fs.Stats, "size" | "mtimeMs" | "ino">): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ino === right.ino;
}
const jsonWorkerSource = `
const { parentPort } = require("node:worker_threads");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
parentPort.on("message", async message => {
  try {
    if (message.kind === "read") {
      const text = await fs.readFile(message.file, "utf8");
      parentPort.postMessage({ id: message.id, value: JSON.parse(text) });
    } else {
      await fs.mkdir(path.dirname(message.file), { recursive: true, mode: 0o700 });
      const temp = message.file + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
      try {
        await fs.writeFile(temp, JSON.stringify(message.value) + String.fromCharCode(10), { flag: "wx", mode: 0o600 });
        await fs.rename(temp, message.file);
      } finally { await fs.rm(temp, { force: true }); }
      parentPort.postMessage({ id: message.id, value: true });
    }
  } catch (error) {
    parentPort.postMessage({ id: message.id, error: { name: error && error.name, message: String(error && error.message || error), code: error && error.code } });
  }
});
`;
let jsonWorker: Worker | null = null;
let nextJsonJob = 0;
const jsonJobs = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
function conversationJson<T>(kind: "read" | "write", filename: string, value?: unknown): Promise<T> {
  if (!jsonWorker) {
    jsonWorker = new Worker(jsonWorkerSource, { eval: true });
    jsonWorker.on("message", (message: { id: number; value?: unknown; error?: { name?: string; message: string; code?: string } }) => {
      const job = jsonJobs.get(message.id);
      if (!job) return;
      jsonJobs.delete(message.id);
      if (jsonJobs.size === 0) jsonWorker?.unref();
      if (message.error) { const error = new Error(message.error.message); Object.assign(error, { name: message.error.name, code: message.error.code }); job.reject(error); }
      else job.resolve(message.value);
    });
    jsonWorker.on("error", error => {
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const job of jsonJobs.values()) job.reject(failure);
      jsonJobs.clear(); jsonWorker = null;
    });
  }
  const id = ++nextJsonJob;
  const worker = jsonWorker;
  worker.ref();
  return new Promise<T>((resolve, reject) => {
    jsonJobs.set(id, { resolve: resolve as (value: unknown) => void, reject });
    worker.postMessage({ id, kind, file: filename, value });
  });
}
async function cachedRunRecords(): Promise<RunRecord[]> {
  const filename = externalRelayFile("runs");
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await fs.promises.stat(filename).catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? null : Promise.reject(error));
    if (!before) { runLedgerCache.delete(filename); return []; }
    const cached = runLedgerCache.get(filename);
    if (cached && sameFileVersion(cached, before)) return cached.runs;
    let ledger: { v?: unknown; runs?: unknown };
    try { ledger = await conversationJson("read", filename); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (ledger.v !== 1 || !Array.isArray(ledger.runs)) throw new Error("invalid run ledger");
    const after = await fs.promises.stat(filename).catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? null : Promise.reject(error));
    if (!after || !sameFileVersion(before, after)) continue;
    const runs = ledger.runs as RunRecord[];
    runLedgerCache.set(filename, { size: before.size, mtimeMs: before.mtimeMs, ino: before.ino, runs });
    while (runLedgerCache.size > 8) runLedgerCache.delete(runLedgerCache.keys().next().value!);
    return runs;
  }
  throw new Error("run ledger changed during read");
}
async function cachedConversationRows(): Promise<RelayConversation[]> {
  const filename = file();
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await fs.promises.stat(filename).catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? null : Promise.reject(error));
    if (!before) { conversationCache.delete(filename); return []; }
    const cached = conversationCache.get(filename);
    if (cached && sameFileVersion(cached, before)) return cached.rows;
    const rows = await readConversationRowsAsync();
    const after = await fs.promises.stat(filename).catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? null : Promise.reject(error));
    if (!after || !sameFileVersion(before, after)) continue;
    rememberConversationRowsAt(rows, before);
    return rows;
  }
  throw new Error("conversation map changed during read");
}
async function cachedScopeRows(relay: PairedRelay, target: RelayTargetSettings, request: ExternalRelayRequest): Promise<RelayConversation[]> {
  const filename = file();
  const stat = await fs.promises.stat(filename).catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? null : Promise.reject(error));
  if (!stat) return [];
  const cached = conversationCache.get(filename);
  if (cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.ino === stat.ino)
    return (cached.scopes.get(`${relay.id}\u0000${target.id}\u0000${request.chat?.key ?? ""}`) ?? []).map(row => ({ ...row }));
  await cachedConversationRows();
  return cachedScopeRows(relay, target, request);
}
function rememberConversationRows(rows: RelayConversation[]) {
  const filename = file();
  try {
    const stat = fs.statSync(filename);
    rememberConversationRowsAt(rows, stat);
  } catch { conversationCache.delete(filename); }
}
function rememberConversationRowsAt(rows: RelayConversation[], stat: Pick<fs.Stats, "size" | "mtimeMs" | "ino">) {
  const filename = file();
  conversationCache.delete(filename);
  const scopes = new Map<string, RelayConversation[]>();
  for (const row of rows) {
    const key = `${row.relayId}\u0000${row.targetId}\u0000${row.chatKey}`;
    const group = scopes.get(key) ?? [];
    group.push(row); scopes.set(key, group);
  }
  conversationCache.set(filename, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, rows, scopes });
  while (conversationCache.size > 8) conversationCache.delete(conversationCache.keys().next().value!);
}
function readConversationRows(migrate = false): RelayConversation[] {
  try {
    const value = JSON.parse(fs.readFileSync(file(), "utf8"));
    return rowsFromValue(value, migrate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if (!(error instanceof SyntaxError) && !(error instanceof Error && error.message === "invalid conversations")) throw error;
    try { fs.renameSync(file(), `${file()}.corrupt-${randomUUID()}`); }
    catch (moveError) { if ((moveError as NodeJS.ErrnoException).code !== "ENOENT") throw moveError; }
    return [];
  }
}
function rowsFromValue(input: unknown, migrate = false): RelayConversation[] {
  const value = input as { v?: unknown; conversations?: unknown } | null;
  const version = value?.v;
  const conversations = value?.conversations;
  if (!value || ![1, 2].includes(version as number) || !Array.isArray(conversations) || conversations.some((item: unknown) => {
    const r = item as RelayConversation;
    return !r || typeof r.id !== "string" || !/^[0-9a-f-]{36}$/.test(r.id) ||
    (r.authority === "owner-tier" ? r.cwd !== null : typeof r.cwd !== "string" || path.basename(r.cwd) !== `llv-relay-conv-${r.id}`) ||
    !["claude", "codex"].includes(r.engine) || !["running", "idle", "broken"].includes(r.state) || !Array.isArray(r.seen) ||
    version === 2 && (typeof r.requesterKey !== "string" || !["member", "admin", "owner", "owner-tier"].includes(r.authority) ||
      !Array.isArray(r.anchors) || r.anchors.length > 200 || r.seen.length > 200 ||
      [...r.anchors, ...r.seen].some(id => typeof id !== "string") ||
      r.pendingCursor !== undefined && (!r.pendingCursor || typeof r.pendingCursor.operationId !== "string" ||
        !Array.isArray(r.pendingCursor.seen) || r.pendingCursor.seen.length > 200 ||
        r.pendingCursor.seen.some(id => typeof id !== "string") || typeof r.pendingCursor.staticDigest !== "string"));
  })) throw new Error("invalid conversations");
  if (version === 1) {
    if (migrate) for (const item of conversations as RelayConversation[]) deleteConversationFiles(item);
    return [];
  }
  return conversations as RelayConversation[];
}
async function readConversationRowsAsync(migrate = false): Promise<RelayConversation[]> {
  try {
    const value = await conversationJson("read", file());
    const rows = rowsFromValue(value);
    if (migrate && (value as { v?: unknown; conversations?: unknown } | null)?.v === 1) {
      const legacy = (value as { conversations: RelayConversation[] }).conversations;
      await Promise.all(legacy.map(deleteConversationFilesAsync));
    }
    return rows;
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if (!(error instanceof SyntaxError) && !(error instanceof Error && (error.name === "SyntaxError" || error.message === "invalid conversations"))) throw error;
    try { await fs.promises.rename(file(), `${file()}.corrupt-${randomUUID()}`); }
    catch (moveError) { if ((moveError as NodeJS.ErrnoException).code !== "ENOENT") throw moveError; }
    return [];
  }
}
async function writeConversationRowsAsync(rows: RelayConversation[]) {
  await conversationJson("write", file(), { v: 2, conversations: rows });
}
async function rememberConversationRowsAsync(rows: RelayConversation[]) {
  const filename = file();
  try {
    const stat = await fs.promises.stat(filename);
    rememberConversationRowsAt(rows, stat);
  } catch { conversationCache.delete(filename); }
}
export function readConversations(): RelayConversation[] { return withViewerOperation("external-relay.chains", () => readConversationRows()); }
function change<T>(action: (rows: RelayConversation[]) => T): T {
  return withViewerOperation("external-relay.chains", () => withFileLock(file(), () => { const rows = readConversationRows(true); const result = action(rows); writeRelayFile(file(), { v: 2, conversations: rows }); rememberConversationRows(rows); return result; }));
}
export function conversationAuthority(requester?: ExternalRelayRequester | null, ownerTier = false): ConversationAuthority | null {
  return !requester ? null : ownerTier ? "owner-tier" : requester.is_owner ? "owner" : requester.is_admin ? "admin" : "member";
}
const encodedCwd = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
export { isRelayConversationDir } from "./conversationPrivacy";
export const conversationCodexHome = (record: RelayConversation) => statePath(`external-relay/conversations/${record.id}/codex`);
export function deleteConversationFiles(record: RelayConversation) {
  if (record.authority === "owner-tier") return;
  // Only the reserved directories minted by this module may be removed.
  if (!/^[0-9a-f-]{36}$/.test(record.id) || path.basename(record.cwd!) !== `llv-relay-conv-${record.id}`) throw new Error("invalid conversation directory");
  fs.rmSync(record.cwd!, { recursive: true, force: true });
  fs.rmSync(statePath(`external-relay/conversations/${record.id}`), { recursive: true, force: true });
  for (const root of claudeProjectRoots()) fs.rmSync(path.join(root, encodedCwd(record.cwd!)), { recursive: true, force: true });
}
async function deleteConversationFilesAsync(record: RelayConversation): Promise<void> {
  if (record.authority === "owner-tier") return;
  if (!/^[0-9a-f-]{36}$/.test(record.id) || path.basename(record.cwd!) !== `llv-relay-conv-${record.id}`) throw new Error("invalid conversation directory");
  await Promise.all([
    fs.promises.rm(record.cwd!, { recursive: true, force: true }),
    fs.promises.rm(statePath(`external-relay/conversations/${record.id}`), { recursive: true, force: true }),
    ...claudeProjectRoots().map(root => fs.promises.rm(path.join(root, encodedCwd(record.cwd!)), { recursive: true, force: true })),
  ]);
}
function fresh(record: RelayConversation) {
  deleteConversationFiles(record);
  resetConversationFields(record);
}
async function freshAsync(record: RelayConversation) {
  await deleteConversationFilesAsync(record);
  resetConversationFields(record);
}
function resetConversationFields(record: RelayConversation) {
  Object.assign(record, { conversationId: null, sessionId: null, seen: [], staticDigest: null, turnsSinceCompaction: 0, lastPromptTokens: null, state: "idle", runningRequestId: null });
}
const capIds = (ids: string[]) => [...new Set(ids)].slice(-200);
function scopedChat(row: RelayConversation, relay: PairedRelay, target: RelayTargetSettings, request: ExternalRelayRequest) {
  return row.relayId === relay.id && row.targetId === target.id && row.chatKey === request.chat?.key;
}
/** Learn bot anchors to a fixed point; then walk only explicit reply edges. */
function resolveChain(rows: RelayConversation[], relay: PairedRelay, target: RelayTargetSettings, request: ExternalRelayRequest, authority: ConversationAuthority): RelayConversation | null {
  const chat = rows.filter(row => scopedChat(row, relay, target, request));
  const pins = new Map<string, RelayConversation[]>();
  for (const row of chat) for (const id of row.anchors) pins.set(id, [...(pins.get(id) ?? []), row]);
  for (let pass = 0; pass < request.input.conversation.length; pass++) {
    let learned = false;
    for (const message of request.input.conversation) {
      if (!message.author.self || !message.reply_to || pins.has(message.id)) continue;
      const parents = pins.get(message.reply_to);
      if (!parents) continue;
      for (const row of parents) row.anchors = capIds([...row.anchors, message.id]);
      pins.set(message.id, parents); learned = true;
    }
    if (!learned) break;
  }
  const messages = new Map(request.input.conversation.map(m => [m.id, m]));
  let id = request.input.respond_to;
  const visited = new Set<string>();
  while (id && !visited.has(id) && visited.size <= messages.size) {
    visited.add(id);
    const found = pins.get(id)?.find(row => row.requesterKey === request.input.requester?.key && row.authority === authority && row.engine === target.engine);
    if (found) return found;
    id = messages.get(id)?.reply_to ?? null;
  }
  return null;
}
export function resolveChainConversation(...args: Parameters<typeof resolveChain>): RelayConversation | null {
  return withViewerOperation("external-relay.chains", () => resolveChain(...args));
}
export async function lookupChainConversationAsync(relay: PairedRelay, target: RelayTargetSettings, request: ExternalRelayRequest, authority: ConversationAuthority): Promise<RelayConversation | null> {
  const rows = (await cachedScopeRows(relay, target, request)).map(row => ({ ...row, anchors: [...row.anchors] }));
  return resolveChain(rows, relay, target, request, authority);
}
/** Persist learned bot anchors even while the resolved turn is held. */
export async function resolveChainConversationAsync(relay: PairedRelay, target: RelayTargetSettings, request: ExternalRelayRequest, authority: ConversationAuthority, until: number): Promise<RelayConversation | null> {
  const rows = await cachedScopeRows(relay, target, request);
  const anchorsBefore = new Map(rows.map(row => [row.id, row.anchors.join("\u0000")]));
  const record = resolveChain(rows, relay, target, request, authority);
  const learned = rows.some(row => anchorsBefore.get(row.id) !== row.anchors.join("\u0000"));
  if (learned) {
    await changeAsync(current => {
      const before = new Map(current.map(row => [row.id, row.anchors.join("\u0000")]));
      resolveChain(current, relay, target, request, authority);
      return current.some(row => before.get(row.id) !== row.anchors.join("\u0000"));
    }, until, changed => changed);
  }
  let resolved = record ? { ...record } : null;
  if (resolved?.state === "running" && !(await cachedRunRecords()).some(run => run.requestId === resolved!.runningRequestId)) {
    await sweepConversationsAsync([relay], Date.now(), until, relay.id);
    const recoveredRows = await cachedScopeRows(relay, target, request);
    resolved = resolveChain(recoveredRows, relay, target, request, authority);
  }
  const pending = resolved?.pendingCursor;
  if (pending) {
    const { resolveSendReceipt } = await import("@/lib/runtime/sendSettlement");
    const receipt = await resolveSendReceipt(pending.operationId);
    if (receipt?.state === "delivered" && receipt.conversationId === resolved!.conversationId) {
      const advanced = await changeAsync(rows => {
        const live = rows.find(row => row.id === resolved!.id);
        if (live?.pendingCursor?.operationId === pending.operationId) {
          live.seen = pending.seen; live.staticDigest = pending.staticDigest; delete live.pendingCursor;
          return { record: { ...live }, changed: true };
        }
        return { record: live ? { ...live } : null, changed: false };
      }, until, result => result.changed);
      resolved = advanced.record;
    } else if (receipt?.state === "failed" || !receipt && !(await cachedRunRecords()).some(run =>
      run.ownerTurn?.continuation?.operationId === pending.operationId && run.conversationId === resolved!.conversationId)) {
      const cleared = await changeAsync(rows => {
        const live = rows.find(row => row.id === resolved!.id);
        if (live?.pendingCursor?.operationId === pending.operationId) {
          delete live.pendingCursor;
          return { record: { ...live }, changed: true };
        }
        return { record: live ? { ...live } : null, changed: false };
      }, until, result => result.changed);
      resolved = cleared.record;
    }
  }
  return resolved;
}
function reservation(relay: PairedRelay, target: RelayTargetSettings, request: ExternalRelayRequest, authority: ConversationAuthority) {
  return (rows: RelayConversation[]) => {
    let record = resolveChainConversation(rows, relay, target, request, authority);
    if (record?.state === "running" || record?.pendingCursor) return null;
    if (record && (record.state === "broken" || transcriptBytes(record) > 32 * 1024 * 1024)) fresh(record);
    if (!record) {
      const owned = rows.filter(row => row.relayId === relay.id);
      if (owned.length >= 300) {
        const oldest = owned.filter(row => row.state !== "running").sort((a,b) => a.lastTurnAt.localeCompare(b.lastTurnAt) || a.id.localeCompare(b.id))[0];
        if (!oldest) return null;
        deleteConversationFiles(oldest); rows.splice(rows.indexOf(oldest), 1);
      }
      const id = randomUUID(); const now = new Date().toISOString();
      const temporary = path.resolve(os.tmpdir()); const home = path.resolve(os.homedir());
      record = { id, relayId: relay.id, targetId: target.id, chatKey: request.chat!.key, requesterKey: request.input.requester!.key,
        authority, anchors: [], conversationId: null, engine: target.engine === "codex-cloud" ? "codex" : target.engine!, sessionId: null, accountId: null,
        cwd: authority === "owner-tier" ? null : path.join(temporary === home || temporary.startsWith(home + path.sep) ? "/tmp" : temporary, `llv-relay-conv-${id}`),
        turns: 0, turnsSinceCompaction: 0, createdAt: now, lastTurnAt: now, seen: [], staticDigest: null, lastPromptTokens: null, compactions: 0, state: "idle", runningRequestId: null };
      rows.push(record);
    }
    record.anchors = capIds([...record.anchors, ...(request.input.respond_to ? [request.input.respond_to] : [])]);
    record.state = "running"; record.runningRequestId = request.request_id;
    return { ...record };
  };
}
function reservationAsync(relay: PairedRelay, target: RelayTargetSettings, request: ExternalRelayRequest, authority: ConversationAuthority) {
  return async (rows: RelayConversation[]) => {
    const anchorsBefore = new Map(rows.map(row => [row.id, row.anchors.join("\u0000")]));
    let record = resolveChainConversation(rows, relay, target, request, authority);
    let changed = rows.some(row => anchorsBefore.get(row.id) !== row.anchors.join("\u0000"));
    if (record?.state === "running" || record?.pendingCursor) return { record: null, changed };
    if (record && (record.state === "broken" || await transcriptBytesAsync(record) > 32 * 1024 * 1024)) {
      await freshAsync(record); changed = true;
    }
    if (!record) {
      const owned = rows.filter(row => row.relayId === relay.id);
      if (owned.length >= 300) {
        const oldest = owned.filter(row => row.state !== "running").sort((a,b) => a.lastTurnAt.localeCompare(b.lastTurnAt) || a.id.localeCompare(b.id))[0];
        if (!oldest) return { record: null, changed };
        await deleteConversationFilesAsync(oldest); rows.splice(rows.indexOf(oldest), 1); changed = true;
      }
      const id = randomUUID(); const now = new Date().toISOString();
      const temporary = path.resolve(os.tmpdir()); const home = path.resolve(os.homedir());
      record = { id, relayId: relay.id, targetId: target.id, chatKey: request.chat!.key, requesterKey: request.input.requester!.key,
        authority, anchors: [], conversationId: null, engine: target.engine === "codex-cloud" ? "codex" : target.engine!, sessionId: null, accountId: null,
        cwd: authority === "owner-tier" ? null : path.join(temporary === home || temporary.startsWith(home + path.sep) ? "/tmp" : temporary, `llv-relay-conv-${id}`),
        turns: 0, turnsSinceCompaction: 0, createdAt: now, lastTurnAt: now, seen: [], staticDigest: null, lastPromptTokens: null, compactions: 0, state: "idle", runningRequestId: null };
      rows.push(record); changed = true;
    }
    const anchors = capIds([...record.anchors, ...(request.input.respond_to ? [request.input.respond_to] : [])]);
    if (anchors.join("\u0000") !== record.anchors.join("\u0000") || record.state !== "running" || record.runningRequestId !== request.request_id) changed = true;
    record.anchors = anchors;
    record.state = "running"; record.runningRequestId = request.request_id;
    return { record: { ...record }, changed };
  };
}
export function reserveChainConversation(relay: PairedRelay, target: RelayTargetSettings, request: ExternalRelayRequest, authority: ConversationAuthority): RelayConversation | null {
  return change(reservation(relay, target, request, authority));
}
export async function reserveChainConversationAsync(relay: PairedRelay, target: RelayTargetSettings, request: ExternalRelayRequest, authority: ConversationAuthority, until: number): Promise<RelayConversation | null> {
  const result = await changeAsync(reservationAsync(relay, target, request, authority), until, outcome => outcome.changed);
  return result.record;
}
export function releaseConversation(id: string, patch: Partial<RelayConversation> = {}) {
  change((rows) => { const record = rows.find((r) => r.id === id); if (record) Object.assign(record, { state: "idle", runningRequestId: null }, patch); });
}
export async function releaseConversationAsync(id: string, patch: Partial<RelayConversation>, until: number, requestId?: string): Promise<void> {
  await changeAsync(rows => {
    const record = rows.find(r => r.id === id);
    if (!record || requestId !== undefined && record.runningRequestId !== requestId) return false;
    const before = JSON.stringify(record);
    Object.assign(record, { state: "idle", runningRequestId: null }, patch);
    return before !== JSON.stringify(record);
  }, until, changed => changed);
}
function changeAsync<T>(action: (rows: RelayConversation[]) => T | Promise<T>, until: number, shouldWrite: (result: T) => boolean = () => true): Promise<T> {
  return withViewerOperation("external-relay.chains", () => withFileLockAsync(file(), async () => {
    const rows = await readConversationRowsAsync(true);
    const result = await action(rows);
    if (shouldWrite(result)) { await writeConversationRowsAsync(rows); await rememberConversationRowsAsync(rows); }
    return result;
  }, until));
}
export function resetConversation(record: RelayConversation) { fresh(record); releaseConversation(record.id, record); }
export function prepareConversationAccount(record: RelayConversation, account: AccountContext) {
  fs.mkdirSync(record.cwd!, { recursive: true, mode: 0o700 });
  const now = new Date(); fs.utimesSync(record.cwd!, now, now);
  if (!record.sessionId) return;
  if (record.engine === "codex") {
    const hasSession = (directory: string, depth = 0): boolean => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return false; }
      return entries.some(entry => entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(`${record.sessionId}.jsonl`)
        || entry.isDirectory() && depth < 4 && hasSession(path.join(directory, entry.name), depth + 1));
    };
    if (!hasSession(path.join(conversationCodexHome(record), "sessions"))) {
      const reservation = { state: record.state, runningRequestId: record.runningRequestId };
      fresh(record); Object.assign(record, reservation);
      fs.mkdirSync(record.cwd!, { recursive: true, mode: 0o700 });
    }
    return;
  }
  const destination = path.join(account.transcriptRoot, encodedCwd(record.cwd!));
  if (fs.existsSync(path.join(destination, `${record.sessionId}.jsonl`))) return;
  for (const root of claudeProjectRoots()) {
    const source = path.join(root, encodedCwd(record.cwd!));
    if (source === destination || !fs.existsSync(path.join(source, `${record.sessionId}.jsonl`))) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    try { fs.renameSync(source, destination); }
    catch { fs.cpSync(source, destination, { recursive: true }); fs.rmSync(source, { recursive: true, force: true }); }
    return;
  }
  const reservation = { state: record.state, runningRequestId: record.runningRequestId };
  fresh(record); Object.assign(record, reservation);
  fs.mkdirSync(record.cwd!, { recursive: true, mode: 0o700 });
}
function transcriptBytes(record: RelayConversation): number {
  if (record.authority === "owner-tier") return 0;
  function size(directory: string): number {
    try { return fs.readdirSync(directory, { withFileTypes: true }).reduce((sum, item) => sum + (item.isDirectory() ? size(path.join(directory, item.name)) : item.isFile() ? fs.statSync(path.join(directory, item.name)).size : 0), 0); }
    catch { return 0; }
  }
  return record.engine === "codex" ? size(conversationCodexHome(record)) : claudeProjectRoots().reduce((sum, root) => sum + size(path.join(root, encodedCwd(record.cwd!))), 0);
}
async function transcriptBytesAsync(record: RelayConversation): Promise<number> {
  if (record.authority === "owner-tier") return 0;
  async function size(directory: string): Promise<number> {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { return 0; }
    const nested = await Promise.all(entries.map(async item => {
      const child = path.join(directory, item.name);
      if (item.isDirectory()) return size(child);
      if (!item.isFile()) return 0;
      try { return (await fs.promises.stat(child)).size; } catch { return 0; }
    }));
    return nested.reduce((sum, bytes) => sum + bytes, 0);
  }
  return record.engine === "codex" ? size(conversationCodexHome(record))
    : (await Promise.all(claudeProjectRoots().map(root => size(path.join(root, encodedCwd(record.cwd!)))))).reduce((sum, bytes) => sum + bytes, 0);
}
export function sweepConversations(relays: PairedRelay[], runs: RunRecord[], now = Date.now(), removeRelayId?: string, onlyRelayId?: string) {
  if (!fs.existsSync(file())) return;
  change(sweepAction(relays, runs, now, removeRelayId, onlyRelayId));
}
export async function sweepConversationsAsync(relays: PairedRelay[], now: number, until: number, onlyRelayId?: string, removeRelayId?: string): Promise<void> {
  if (!fs.existsSync(file())) return;
  await changeAsync(async rows => {
    // Read custody only after winning the conversation lock. A run may have
    // been reserved while this sweep waited, and must keep its pin live.
    const runs = await cachedRunRecords();
    let changed = false;
    for (let i = rows.length - 1; i >= 0; i--) {
      const record = rows[i]!;
      if (onlyRelayId && record.relayId !== onlyRelayId) continue;
      const relay = relays.find(item => item.id === record.relayId);
      const target = relay?.targets.find(item => item.id === record.targetId);
      const run = runs.find(run => run.requestId === record.runningRequestId);
      if (record.state === "running" && (!run || !runHoldsConversation(run) && (run.ownerTurn?.quarantinedAt || !relayRequestInFlight(run.requestId)))) {
        // Quarantine leaves uncertain delivery in the run ledger. Its cursor
        // must stop reserving this chain so the next turn starts fresh.
        if (run?.ownerTurn?.quarantinedAt) delete record.pendingCursor;
        record.state = run?.ownerTurn?.quarantinedAt ? "broken" : "idle"; record.runningRequestId = null; changed = true;
      }
      if (record.state === "running") continue;
      const expired = record.relayId === removeRelayId || !target || (target.engine === "codex-cloud" ? "codex" : target.engine) !== record.engine ||
        now - Date.parse(record.lastTurnAt) > 3 * 86400000 || await transcriptBytesAsync(record) > 32 * 1024 * 1024;
      if (expired) { await deleteConversationFilesAsync(record); rows.splice(i, 1); changed = true; }
    }
    return changed;
  }, until, changed => changed);
}
function sweepAction(relays: PairedRelay[], runs: RunRecord[], now: number, removeRelayId?: string, onlyRelayId?: string, sizes = true) {
  return (rows: RelayConversation[]) => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const record = rows[i]!; if (onlyRelayId && record.relayId !== onlyRelayId) continue; const relay = relays.find((r) => r.id === record.relayId); const target = relay?.targets.find((t) => t.id === record.targetId);
      const run = runs.find(run => run.requestId === record.runningRequestId);
      if (record.state === "running" && (!run || !runHoldsConversation(run) && (run.ownerTurn?.quarantinedAt || !relayRequestInFlight(run.requestId)))) {
        if (run?.ownerTurn?.quarantinedAt) delete record.pendingCursor;
        record.state = run?.ownerTurn?.quarantinedAt ? "broken" : "idle"; record.runningRequestId = null;
      }
      if (record.state === "running") continue;
      if (record.relayId === removeRelayId || !target || (target.engine === "codex-cloud" ? "codex" : target.engine) !== record.engine || now - Date.parse(record.lastTurnAt) > 3 * 86400000 || sizes && transcriptBytes(record) > 32 * 1024 * 1024) {
        deleteConversationFiles(record); rows.splice(i, 1);
      }
    }
  };
}
