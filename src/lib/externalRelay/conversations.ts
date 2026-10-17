import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { statePath } from "@/lib/configDir";
import { claudeProjectRoots } from "@/lib/accounts/claude";
import type { AccountContext } from "@/lib/accounts/contracts";
import type { ExternalRelayRequester, ExternalRelayRequest } from "./protocol";
import { withFileLock, withFileLockAsync, readRunLedger, writeRelayFile, type PairedRelay, type RelayTargetSettings, type RunRecord } from "./store";
export type ConversationAuthority = "member" | "admin" | "owner" | "owner-tier";
export type RelayConversation = {
  id: string; relayId: string; targetId: string; chatKey: string; requesterKey: string; authority: ConversationAuthority; anchors: string[]; conversationId: string | null;
  engine: "claude" | "codex"; sessionId: string | null; accountId: string | null; cwd: string | null;
  turns: number; turnsSinceCompaction: number; createdAt: string; lastTurnAt: string;
  seen: string[]; staticDigest: string | null; lastPromptTokens: number | null; compactions: number;
  state: "idle" | "running" | "broken"; runningRequestId: string | null;
};
const file = () => statePath("external-relay/conversations.json");
function readConversationRows(migrate = false): RelayConversation[] {
  try {
    const value = JSON.parse(fs.readFileSync(file(), "utf8"));
    if (![1, 2].includes(value?.v) || !Array.isArray(value.conversations) || value.conversations.some((r: RelayConversation) =>
      !r || typeof r.id !== "string" || !/^[0-9a-f-]{36}$/.test(r.id) ||
      (r.authority === "owner-tier" ? r.cwd !== null : typeof r.cwd !== "string" || path.basename(r.cwd) !== `llv-relay-conv-${r.id}`) ||
      !["claude", "codex"].includes(r.engine) || !["running", "idle", "broken"].includes(r.state) || !Array.isArray(r.seen) ||
      value.v === 2 && (typeof r.requesterKey !== "string" || !["member", "admin", "owner", "owner-tier"].includes(r.authority) ||
        !Array.isArray(r.anchors) || r.anchors.length > 200 || r.seen.length > 200 ||
        [...r.anchors, ...r.seen].some(id => typeof id !== "string")))) throw new Error("invalid conversations");
    // Old per-chat sessions own only reserved files. They cannot supply chain authority.
    if (value.v === 1) {
      if (migrate) for (const row of value.conversations) deleteConversationFiles(row);
      return [];
    }
    return value.conversations;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if (!(error instanceof SyntaxError) && !(error instanceof Error && error.message === "invalid conversations")) throw error;
    try { fs.renameSync(file(), `${file()}.corrupt-${randomUUID()}`); }
    catch (moveError) { if ((moveError as NodeJS.ErrnoException).code !== "ENOENT") throw moveError; }
    return [];
  }
}
export function readConversations(): RelayConversation[] { return withViewerOperation("external-relay.chains", () => readConversationRows()); }
function change<T>(action: (rows: RelayConversation[]) => T): T {
  return withViewerOperation("external-relay.chains", () => withFileLock(file(), () => { const rows = readConversationRows(true); const result = action(rows); writeRelayFile(file(), { v: 2, conversations: rows }); return result; }));
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
function fresh(record: RelayConversation) {
  deleteConversationFiles(record);
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
/** Persist learned bot anchors even while the resolved turn is held. */
export async function resolveChainConversationAsync(relay: PairedRelay, target: RelayTargetSettings, request: ExternalRelayRequest, authority: ConversationAuthority, until: number): Promise<RelayConversation | null> {
  if (!fs.existsSync(file())) return null;
  return changeAsync(rows => {
    sweepAction([relay], readRunLedger().runs, Date.now(), undefined, relay.id, false)(rows);
    const record = resolveChain(rows, relay, target, request, authority);
    return record ? { ...record } : null;
  }, until);
}
function reservation(relay: PairedRelay, target: RelayTargetSettings, request: ExternalRelayRequest, authority: ConversationAuthority) {
  return (rows: RelayConversation[]) => {
    let record = resolveChainConversation(rows, relay, target, request, authority);
    if (record?.state === "running") return null;
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
        authority, anchors: [], conversationId: null, engine: target.engine!, sessionId: null, accountId: null,
        cwd: authority === "owner-tier" ? null : path.join(temporary === home || temporary.startsWith(home + path.sep) ? "/tmp" : temporary, `llv-relay-conv-${id}`),
        turns: 0, turnsSinceCompaction: 0, createdAt: now, lastTurnAt: now, seen: [], staticDigest: null, lastPromptTokens: null, compactions: 0, state: "idle", runningRequestId: null };
      rows.push(record);
    }
    record.anchors = capIds([...record.anchors, ...(request.input.respond_to ? [request.input.respond_to] : [])]);
    record.state = "running"; record.runningRequestId = request.request_id;
    return { ...record };
  };
}
export function reserveChainConversation(relay: PairedRelay, target: RelayTargetSettings, request: ExternalRelayRequest, authority: ConversationAuthority): RelayConversation | null {
  return change(reservation(relay, target, request, authority));
}
export async function reserveChainConversationAsync(relay: PairedRelay, target: RelayTargetSettings, request: ExternalRelayRequest, authority: ConversationAuthority, until: number): Promise<RelayConversation | null> {
  return changeAsync(reservation(relay, target, request, authority), until);
}
export function releaseConversation(id: string, patch: Partial<RelayConversation> = {}) {
  change((rows) => { const record = rows.find((r) => r.id === id); if (record) Object.assign(record, { state: "idle", runningRequestId: null }, patch); });
}
export async function releaseConversationAsync(id: string, patch: Partial<RelayConversation>, until: number): Promise<void> {
  await changeAsync(rows => { const record = rows.find(r => r.id === id); if (record) Object.assign(record, { state: "idle", runningRequestId: null }, patch); }, until);
}
function changeAsync<T>(action: (rows: RelayConversation[]) => T, until: number): Promise<T> {
  return withViewerOperation("external-relay.chains", () => withFileLockAsync(file(), () => { const rows = readConversationRows(true); const result = action(rows); writeRelayFile(file(), { v: 2, conversations: rows }); return result; }, until));
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
export function sweepConversations(relays: PairedRelay[], runs: RunRecord[], now = Date.now(), removeRelayId?: string, onlyRelayId?: string) {
  if (!fs.existsSync(file())) return;
  change(sweepAction(relays, runs, now, removeRelayId, onlyRelayId));
}
export async function sweepConversationsAsync(relays: PairedRelay[], now: number, until: number, onlyRelayId?: string): Promise<void> {
  if (!fs.existsSync(file())) return;
  await changeAsync(rows => sweepAction(relays, readRunLedger().runs, now, undefined, onlyRelayId, false)(rows), until);
}
function sweepAction(relays: PairedRelay[], runs: RunRecord[], now: number, removeRelayId?: string, onlyRelayId?: string, sizes = true) {
  return (rows: RelayConversation[]) => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const record = rows[i]!; if (onlyRelayId && record.relayId !== onlyRelayId) continue; const relay = relays.find((r) => r.id === record.relayId); const target = relay?.targets.find((t) => t.id === record.targetId);
      if (record.state === "running" && !runs.some((r) => r.requestId === record.runningRequestId)) { record.state = "idle"; record.runningRequestId = null; }
      if (record.state === "running") continue;
      if (record.relayId === removeRelayId || !target || target.engine !== record.engine || now - Date.parse(record.lastTurnAt) > 3 * 86400000 || sizes && transcriptBytes(record) > 32 * 1024 * 1024) {
        deleteConversationFiles(record); rows.splice(i, 1);
      }
    }
  };
}
